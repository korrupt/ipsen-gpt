import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { allow, clientIp, requireSession, sessionOf } from '../http.js';
import { OllamaError, streamChat } from '../ollama.js';
import type { PeopleStore } from '../people.js';
import { buildMessages } from '../prompt.js';
import type { Session } from '../sessions.js';
import type { Services } from '../services.js';
import { openSse } from '../sse.js';

export interface ChatRouteDeps {
  config: Config;
  services: Services;
  getPersona: () => string;
  log: (msg: string, err?: unknown) => void;
}

/** Shown to the guest when the model fails. Real errors are only logged. */
export const MODEL_FAILURE_MESSAGE =
  'IpsenGPT has lost contact with the other side. Try again in a moment.';

export const BUSY_MESSAGE = 'IpsenGPT is still answering your last message.';

/** System prompt sections describing who IpsenGPT is talking to. */
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

export function chatRouter({ config, services, getPersona, log }: ChatRouteDeps): Router {
  const router = Router();
  const { sessions, people, limiter, inFlight } = services;
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
    if (session.name === null) {
      res.status(409).json({ error: 'Pick a name first.', code: 'name_required' });
      return;
    }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    if (inFlight.has(session.id)) {
      res.status(429).json({ error: BUSY_MESSAGE });
      return;
    }
    if (!allow(limiter, res, `chat:ip:${clientIp(req)}`, config.rateLimits.chatPerIp)) return;
    if (!allow(limiter, res, `chat:session:${session.id}`, config.rateLimits.chatPerSession)) return;

    let persona: string;
    try {
      persona = getPersona();
    } catch (err) {
      log('Failed to load persona', err);
      res.status(500).json({ error: MODEL_FAILURE_MESSAGE });
      return;
    }

    const userMessage = parsed.data.message;
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
      for await (const delta of streamChat(config.ollama, messages, abort.signal)) {
        reply += delta;
        sse.send('token', { text: delta });
      }
      sessions.addExchange(session.id, userMessage, reply);
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
