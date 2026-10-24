import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { allow, clientIp } from '../http.js';
import { PeopleError, type Person } from '../people.js';
import { SessionError, type Session } from '../sessions.js';
import type { Services } from '../services.js';

const PasswordBody = z.object({ password: z.string().max(500) });
const AssignBody = z.object({ slug: z.string().min(1) });
const ToggleBody = z.object({ enabled: z.boolean() });
const PersonBody = z.object({
  name: z.string().max(200),
  aliases: z.array(z.string().max(200)).max(50).default([]),
  info: z.string().max(20_000).default(''),
});

export function adminRouter(config: Config, services: Services): Router {
  const router = Router();
  const { adminAuth, sessions, people, limiter, llm, settings, errors } = services;

  const personName = (slug: string | null) => (slug ? (people.get(slug)?.name ?? `${slug} (deleted)`) : null);

  const sessionSummary = (s: Session & { messageCount?: number }) => ({
    id: s.id,
    name: s.name,
    state: s.state,
    claimCode: s.claimCode,
    person: s.personSlug ? { slug: s.personSlug, name: personName(s.personSlug) } : null,
    claimPerson: s.claimPersonSlug ? { slug: s.claimPersonSlug, name: personName(s.claimPersonSlug) } : null,
    notice: s.notice,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    messageCount: s.messageCount,
  });

  const personView = (p: Person) => ({
    ...p,
    claimedBy: (() => {
      const h = sessions.holderOf(p.slug);
      return h ? { id: h.id, name: h.name } : null;
    })(),
  });

  /** Maps store errors to 4xx; anything else is a real 500. */
  const handle = (res: Response, fn: () => unknown) => {
    try {
      const result = fn();
      res.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof SessionError || err instanceof PeopleError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  };

  // --- Auth -----------------------------------------------------------------

  router.post('/login', (req, res) => {
    if (!adminAuth.enabled) {
      res.status(503).json({ error: 'Admin is disabled. Set ADMIN_PASSWORD in .env.' });
      return;
    }
    if (!allow(limiter, res, `admin-login:ip:${clientIp(req)}`, config.rateLimits.adminLoginPerIp)) return;
    const body = PasswordBody.safeParse(req.body);
    if (!body.success || !adminAuth.checkPassword(body.data.password)) {
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    limiter.reset(`admin-login:ip:${clientIp(req)}`);
    adminAuth.setCookie(res, adminAuth.createSession());
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    adminAuth.destroy(adminAuth.tokenFrom(req));
    adminAuth.clearCookie(res);
    res.json({ ok: true });
  });

  router.use(adminAuth.require);

  router.get('/me', (_req, res) => {
    res.json({ ok: true });
  });

  // --- Claims ---------------------------------------------------------------

  router.get('/claims', (req, res) => {
    const q = typeof req.query.code === 'string' ? req.query.code : '';
    res.json({ claims: sessions.pendingClaims(q).map(sessionSummary) });
  });

  router.post('/claims/:id/approve', (req, res) =>
    handle(res, () => ({ session: sessionSummary(sessions.approveClaim(req.params.id)) })),
  );

  router.post('/claims/:id/reject', (req, res) =>
    handle(res, () => ({ session: sessionSummary(sessions.rejectClaim(req.params.id)) })),
  );

  // --- Sessions -------------------------------------------------------------

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: sessions.list().map(sessionSummary) });
  });

  router.get('/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ session: sessionSummary(s), messages: sessions.recentMessages(s.id, 1000) });
  });

  router.post('/sessions/:id/assign', (req, res) => {
    const body = AssignBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a person' });
      return;
    }
    handle(res, () => ({ session: sessionSummary(sessions.assignPerson(req.params.id, body.data.slug)) }));
  });

  router.post('/sessions/:id/release-name', (req, res) =>
    handle(res, () => ({ session: sessionSummary(sessions.releaseName(req.params.id)) })),
  );

  router.post('/sessions/:id/end', (req, res) => handle(res, () => sessions.end(req.params.id)));

  // --- System ---------------------------------------------------------------

  router.get('/system', async (_req, res) => {
    res.json({ llm: await llm.status(), errors: errors.recent() });
  });

  router.post('/system/force-fallback', (req, res) => {
    const body = ToggleBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Expected { enabled: boolean }' });
      return;
    }
    if (body.data.enabled && !llm.hasFallback) {
      res.status(409).json({ error: 'No fallback model is configured (OLLAMA_FALLBACK_URL).' });
      return;
    }
    settings.set('forceFallback', body.data.enabled);
    res.json({ forceFallback: body.data.enabled });
  });

  // --- People ---------------------------------------------------------------

  router.get('/people', (_req, res) => {
    res.json({ people: people.list().map(personView), errors: people.errors });
  });

  router.post('/people/reload', (_req, res) => {
    people.load();
    res.json({ people: people.list().map(personView), errors: people.errors });
  });

  router.post('/people', (req, res) => {
    const body = PersonBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid person' });
      return;
    }
    handle(res, () => ({ person: personView(people.save(body.data)) }));
  });

  router.put('/people/:slug', (req, res) => {
    const body = PersonBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid person' });
      return;
    }
    handle(res, () => {
      const saved = people.save(body.data, req.params.slug);
      sessions.personUpdated(saved);
      return { person: personView(saved) };
    });
  });

  router.delete('/people/:slug', (req, res) =>
    handle(res, () => {
      people.delete(req.params.slug);
      sessions.personDeleted(req.params.slug);
    }),
  );

  return router;
}
