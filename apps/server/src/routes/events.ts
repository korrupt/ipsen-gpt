import { Router } from 'express';
import type { Config } from '../config.js';
import { gateView } from '../gates.js';
import { requireSession, sessionOf } from '../http.js';
import type { Services } from '../services.js';
import { openSse } from '../sse.js';

/**
 * GET /api/events: the guest's live stream. Sent on connect and on every change:
 *  - `status` {open, reason, message}: whether chat is open (model reachable, not paused)
 *  - `gate` {gate}: the photo gate blocking chat, or null
 * Events are full snapshots, so a phone that reconnects is up to date at once.
 * (Phase 5 adds curses and claim updates here.)
 */
export function eventsRouter(config: Config, { sessions, gates, llm, events }: Services): Router {
  const router = Router();

  router.get('/events', requireSession(sessions), (_req, res) => {
    const session = sessionOf(res);
    const sse = openSse(res, config.sseHeartbeatMs);
    sse.send('status', llm.status());
    const gate = gates.current(session.id);
    sse.send('gate', { gate: gate ? gateView(gate) : null });
    const unsubscribe = events.subscribe(session.id, (event, data) => sse.send(event, data));
    res.on('close', unsubscribe);
  });

  return router;
}
