import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { OllamaError, streamChat } from '../ollama.js';
import { buildMessages } from '../prompt.js';
import { openSse } from '../sse.js';

export interface ChatRouteDeps {
  config: Config;
  getPersona: () => string;
  log: (msg: string, err?: unknown) => void;
}

/** Shown to the guest when the model fails. Real errors are only logged. */
export const MODEL_FAILURE_MESSAGE =
  'IpsenGPT has lost contact with the other side. Try again in a moment.';

export function chatRouter({ config, getPersona, log }: ChatRouteDeps): Router {
  const router = Router();

  const Body = z.object({
    message: z
      .string()
      .trim()
      .min(1, 'Message is empty')
      .max(config.chat.maxInputChars, `Message is longer than ${config.chat.maxInputChars} characters`),
    // Phase 1 only: the client sends its own history. Moves server-side with SQLite in Phase 2.
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(4000),
        }),
      )
      .max(100)
      .default([]),
  });

  router.post('/chat', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    let persona: string;
    try {
      persona = getPersona();
    } catch (err) {
      log('Failed to load persona', err);
      res.status(500).json({ error: MODEL_FAILURE_MESSAGE });
      return;
    }

    const messages = buildMessages({
      persona,
      history: parsed.data.history,
      historyTurns: config.chat.historyTurns,
      userMessage: parsed.data.message,
    });

    const sse = openSse(res, config.sseHeartbeatMs);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    try {
      for await (const delta of streamChat(config.ollama, messages, abort.signal)) {
        sse.send('token', { text: delta });
      }
      sse.send('done', {});
    } catch (err) {
      if (!(err instanceof OllamaError && err.kind === 'aborted')) {
        log('Chat stream failed', err);
        sse.send('error', { message: MODEL_FAILURE_MESSAGE });
      }
    } finally {
      sse.close();
    }
  });

  return router;
}
