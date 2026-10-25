import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import { gateView, VERDICT_LINES, type Gate } from '../gates.js';
import { allow, clientIp, requireSession, sessionOf } from '../http.js';
import { detectImageType, makeResized, processOriginal } from '../photos.js';
import type { Services } from '../services.js';
import { isPass, parseVerdict, VERDICT_FORMAT, verifyMessages } from '../verify.js';

export const NOT_A_PHOTO = "That doesn't look like a photo. Try another one.";
export const VERIFY_BUSY = 'IpsenGPT is still looking at your last photo.';

/** Accepts any Content-Type: the bytes decide what it is. */
const rawBody = (limit: number | string) => express.raw({ type: () => true, limit });

/**
 * Guest photo uploads, in two steps:
 *  1. POST /photos/verify?gate=<id>&consent=1 with the resized photo (≤ 768 px).
 *     Answers with the verdict; only a verified "yes" passes the gate.
 *  2. PUT /photos/<attempt id>/original with the full-size photo, in the
 *     background. The verdict never waits for it.
 * Both live under /api/photos/, which Nginx lets through at 25 MB.
 */
export function photosRouter(config: Config, services: Services): Router {
  const router = Router();
  const { sessions, gates, photos, limiter, llm, verifying, log } = services;

  /** Everything that can be refused before reading the body. */
  const checkVerify = (req: Request, res: Response, next: NextFunction) => {
    const session = sessionOf(res);
    if (session.name === null) {
      res.status(409).json({ error: 'Pick a name first.', code: 'name_required' });
      return;
    }
    if (req.query.consent !== '1') {
      res.status(400).json({ error: 'Tick the box first: you are responsible for the photo.', code: 'consent_required' });
      return;
    }
    const gate = typeof req.query.gate === 'string' ? gates.get(req.query.gate) : undefined;
    if (!gate || gate.sessionId !== session.id || gate.status !== 'active') {
      const current = gates.current(session.id);
      res.status(409).json({ error: 'That gate is no longer open.', code: 'gate_closed', gate: current ? gateView(current) : null });
      return;
    }
    if (verifying.has(session.id)) {
      res.status(429).json({ error: VERIFY_BUSY });
      return;
    }
    if (!allow(limiter, res, `photo:ip:${clientIp(req)}`, config.rateLimits.photoPerIp)) return;
    if (!allow(limiter, res, `photo:session:${session.id}`, config.rateLimits.photoPerSession)) return;
    // Claimed before the body arrives, so two uploads sent together can't both get in.
    verifying.add(session.id);
    res.on('close', () => verifying.delete(session.id));
    res.locals.gate = gate;
    next();
  };

  /** Asks the model, records the verdict, and passes the gate on a confident yes. Never throws. */
  const verify = async (attemptId: string, gate: Gate, resized: Buffer) => {
    const unverified = (error: string) => {
      photos.setUnverified(attemptId, error);
      return { result: 'unverified', message: VERDICT_LINES.unverified, reason: null } as const;
    };
    let text: string | null;
    try {
      text = await llm.vision(verifyMessages(gate.target, resized.toString('base64')), {
        format: VERDICT_FORMAT,
        temperature: 0,
        timeoutMs: config.photos.verifyTimeoutMs,
      });
    } catch (err) {
      log('Photo verification failed', err);
      return unverified(err instanceof Error ? err.message : String(err));
    }
    if (text === null) return unverified('Vision model unavailable (primary down or forced off)');
    const verdict = parseVerdict(text);
    if (!verdict) return unverified(`Reply was not the expected JSON: ${text.slice(0, 300)}`);
    if (!isPass(verdict, config.photos.confidenceMin)) {
      photos.setVerdict(attemptId, 'failed', verdict);
      return { result: 'failed', message: VERDICT_LINES.failed, reason: verdict.reason || null } as const;
    }
    photos.setVerdict(attemptId, 'passed', verdict);
    // The gate may have expired or been cancelled while the model looked.
    if (gates.get(gate.id)?.status === 'active') gates.pass(gate.id);
    return { result: 'passed', message: VERDICT_LINES.passed, reason: null } as const;
  };

  router.post('/photos/verify', requireSession(sessions), checkVerify, rawBody('3mb'), async (req, res) => {
    const session = sessionOf(res);
    const gate = res.locals.gate as Gate;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!detectImageType(body)) {
      res.status(400).json({ error: NOT_A_PHOTO, code: 'not_a_photo' });
      return;
    }

    let resized: Buffer;
    try {
      resized = await makeResized(body);
    } catch {
      res.status(400).json({ error: NOT_A_PHOTO, code: 'not_a_photo' });
      return;
    }
    const attempt = photos.create({ sessionId: session.id, gateId: gate.id, target: gate.target, resized });
    // The guest may close the page meanwhile; the verdict still counts.
    const outcome = await verify(attempt.id, gate, resized);
    res.json({ attemptId: attempt.id, ...outcome, gate: viewOf(gates.current(session.id)) });
  });

  router.put(
    '/photos/:id/original',
    requireSession(sessions),
    (req, res, next) => {
      const attempt = photos.get(String(req.params.id));
      if (!attempt || attempt.sessionId !== sessionOf(res).id || attempt.deletedAt !== null) {
        res.status(404).json({ error: 'No such photo.' });
        return;
      }
      if (attempt.originalFile) {
        res.status(409).json({ error: 'The original is already stored.' });
        return;
      }
      next();
    },
    rawBody(config.photos.maxOriginalBytes),
    async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = detectImageType(body);
      if (!type) {
        res.status(400).json({ error: NOT_A_PHOTO, code: 'not_a_photo' });
        return;
      }
      const original = await processOriginal(body, type);
      if (!photos.setOriginal(String(req.params.id), original)) {
        res.status(409).json({ error: 'The original is already stored.' });
        return;
      }
      res.json({ ok: true, processed: original.processed });
    },
  );

  return router;
}

const viewOf = (g: Gate | undefined) => (g ? gateView(g) : null);
