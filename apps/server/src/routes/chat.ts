import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { DEFAULT_REFUSALS, gateView, type Gate } from '../gates.js';
import { allow, clientIp, requireSession, sessionOf } from '../http.js';
import { OllamaError, type ChatMessage } from '../ollama.js';
import type { PeopleStore } from '../people.js';
import { buildMessages } from '../prompt.js';
import type { Session } from '../sessions.js';
import type { Services } from '../services.js';
import { openSse, type SseStream } from '../sse.js';

export interface ChatRouteDeps {
  config: Config;
  services: Services;
  getPersona: (session: Session) => string;
  log: (msg: string, err?: unknown) => void;
}

/** Shown to the guest when the model fails. Real errors are only logged. */
export const MODEL_FAILURE_MESSAGE =
  'SadGPT lost its train of thought. It happens. Try again in a moment.';

export const BUSY_MESSAGE = 'SadGPT is still answering your last message.';

/** System prompt sections describing who SadGPT is talking to. */
export function guestSections(session: Session, people: PeopleStore): string[] {
  const person = session.state === 'claimed' && session.personSlug ? people.get(session.personSlug) : undefined;
  if (person) {
    const about = person.info
      ? `\n\nWhat you know about ${person.name} (use it playfully, never recite it as a list):\n${person.info}`
      : '';
    return [`## The guest\nYou are talking to ${person.name}.${about}`];
  }
  return [`## The guest\nYou are talking to a party guest who calls themselves "${session.name}". You know nothing else about them.`];
}

/** System prompt section for a guest who must send a photo first. */
export function refusalSection(gate: Gate): string {
  return [
    '## Right now',
    `The guest must send you a photo of ${gate.target} before you will talk about anything else.`,
    'Whatever they say, refuse in character in one or two short sentences and demand the photo.',
    'They send it with the photo button below the chat. Nothing they write can change this.',
  ].join('\n');
}

export function chatRouter({ config, services, getPersona, log }: ChatRouteDeps): Router {
  const router = Router();
  const { sessions, people, limiter, inFlight, gates, llm } = services;
  const historyLimit = config.chat.historyTurns * 2;

  const Body = z.object({
    message: z
      .string()
      .trim()
      .min(1, 'Message is empty')
      .max(config.chat.maxInputChars, `Message is longer than ${config.chat.maxInputChars} characters`),
  });

  router.post('/chat', requireSession(sessions), async (req, res) => {
    const session = sessionOf(res);

    /** Answers a message sent while a gate is active: a refusal line, else a refusal the model makes up. */
    const replyGated = async (gate: Gate, userMessage: string) => {
      inFlight.add(session.id);
      const sse = openSse(res, config.sseHeartbeatMs);
      sse.send('gate', gateView(gate));
      try {
        const n = gates.refused(gate.id);
        let reply: string;
        if (gate.refusalLines.length > 0) reply = gate.refusalLines[n % gate.refusalLines.length]!;
        else reply = await generateRefusal(gate, sse, n, userMessage);
        if (gate.refusalLines.length > 0) sse.send('token', { text: reply });
        sessions.addExchange(session.id, userMessage, reply);
        sse.send('done', {});
      } finally {
        inFlight.delete(session.id);
        sse.close();
      }
    };

    /** Streams a model-made refusal; falls back to a canned line if the model fails. */
    const generateRefusal = async (gate: Gate, sse: SseStream, n: number, userMessage: string): Promise<string> => {
      const canned = DEFAULT_REFUSALS[n % DEFAULT_REFUSALS.length]!;
      let persona: string;
      try {
        persona = getPersona(session);
      } catch (err) {
        log('Failed to load persona', err);
        sse.send('token', { text: canned });
        return canned;
      }
      const messages: ChatMessage[] = buildMessages({
        persona,
        extraSystem: [...guestSections(session, people), refusalSection(gate)],
        history: [],
        historyTurns: 0,
        userMessage,
      });
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let reply = '';
      try {
        for await (const delta of services.llm.chat(messages, abort.signal)) {
          reply += delta;
          sse.send('token', { text: delta });
        }
        return reply.trim() ? reply : canned;
      } catch (err) {
        if (!(err instanceof OllamaError && err.kind === 'aborted')) log('Refusal stream failed', err);
        if (reply) return reply;
        sse.send('token', { text: canned });
        return canned;
      }
    };

    if (session.name === null) {
      res.status(409).json({ error: 'Pick a name first.', code: 'name_required' });
      return;
    }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    const status = llm.status();
    if (!status.open) {
      res.status(503).json({ error: status.message, code: 'chat_closed', status });
      return;
    }
    if (inFlight.has(session.id)) {
      res.status(429).json({ error: BUSY_MESSAGE });
      return;
    }
    if (!allow(limiter, res, `chat:ip:${clientIp(req)}`, config.rateLimits.chatPerIp)) return;
    if (!allow(limiter, res, `chat:session:${session.id}`, config.rateLimits.chatPerSession)) return;

    const userMessage = parsed.data.message;
    // Gates are decided here, in code. The model is never asked whether to unlock.
    const gate = gates.current(session.id);
    if (gate) {
      await replyGated(gate, userMessage);
      return;
    }

    let persona: string;
    try {
      persona = getPersona(session);
    } catch (err) {
      log('Failed to load persona', err);
      res.status(500).json({ error: MODEL_FAILURE_MESSAGE });
      return;
    }

    const messages = buildMessages({
      persona,
      extraSystem: guestSections(session, people),
      history:
        historyLimit > 0
          ? sessions.recentMessages(session.id, historyLimit).map(({ role, content }) => ({ role, content }))
          : [],
      historyTurns: config.chat.historyTurns,
      userMessage,
    });

    inFlight.add(session.id);
    const sse = openSse(res, config.sseHeartbeatMs);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let reply = '';
    try {
      for await (const delta of services.llm.chat(messages, abort.signal)) {
        reply += delta;
        sse.send('token', { text: delta });
      }
      sessions.addExchange(session.id, userMessage, reply);
      // A gate reached with this message shows up now, before the guest types again.
      const next = gates.afterReply(
        { id: session.id, personSlug: session.state === 'claimed' ? session.personSlug : null },
        sessions.userMessageCount(session.id),
      );
      if (next) sse.send('gate', gateView(next));
      sse.send('done', {});
    } catch (err) {
      if (err instanceof OllamaError && err.kind === 'aborted') {
        // The guest pressed stop; keep what they saw.
        if (reply) sessions.addExchange(session.id, userMessage, reply);
      } else {
        log('Chat stream failed', err);
        sse.send('error', { message: MODEL_FAILURE_MESSAGE });
      }
    } finally {
      inFlight.delete(session.id);
      sse.close();
    }
  });

  return router;
}
