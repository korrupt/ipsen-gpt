import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { GateDef } from '../gateDefs.js';
import { GateError, type Gate } from '../gates.js';
import { allow, clientIp } from '../http.js';
import { PeopleError, type Person } from '../people.js';
import type { PhotoAttempt } from '../photos.js';
import { SessionError, type Session } from '../sessions.js';
import type { Services } from '../services.js';

const PasswordBody = z.object({ password: z.string().max(500) });
const AssignBody = z.object({ slug: z.string().min(1) });
const PauseBody = z.object({
  reason: z.string().trim().min(1, 'Write what guests should see while chat is paused.').max(300, 'Keep the reason under 300 characters.'),
});
const ForceBody = z
  .object({
    /** One session, or every live session with a name. */
    sessionId: z.string().min(1).optional(),
    all: z.literal(true).optional(),
    /** A gate definition, or a one-off typed in by the admin. */
    key: z.string().min(1).optional(),
    custom: z
      .object({ target: z.string().trim().min(1).max(200), guestPrompt: z.string().trim().min(1).max(1000) })
      .optional(),
    deadlineMinutes: z.number().positive().max(24 * 60).optional(),
  })
  .refine((b) => !!b.sessionId !== !!b.all, 'Pick one session or everyone')
  .refine((b) => !!b.key !== !!b.custom, 'Pick a gate or describe a custom one');
const PersonBody = z.object({
  name: z.string().max(200),
  aliases: z.array(z.string().max(200)).max(50).default([]),
  info: z.string().max(20_000).default(''),
});

export function adminRouter(config: Config, services: Services): Router {
  const router = Router();
  const { adminAuth, sessions, people, limiter, llm, settings, errors, gates, gateDefs, photos, events } = services;

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

  const sessionName = (id: string) => sessions.get(id)?.name ?? null;

  const defView = (d: GateDef) => ({
    key: d.key,
    id: d.id,
    person: d.personSlug ? { slug: d.personSlug, name: personName(d.personSlug) } : null,
    target: d.target,
    guestPrompt: d.guestPrompt,
    refusalLines: d.refusalLines,
    points: d.points,
    trigger: d.trigger,
  });

  const gateSummary = (g: Gate & { sessionName?: string | null }) => ({
    id: g.id,
    sessionId: g.sessionId,
    sessionName: g.sessionName !== undefined ? g.sessionName : sessionName(g.sessionId),
    defKey: g.defKey,
    source: g.source,
    target: g.target,
    guestPrompt: g.guestPrompt,
    points: g.points,
    status: g.status,
    refusals: g.refusals,
    createdAt: g.createdAt,
    deadlineAt: g.deadlineAt,
    resolvedAt: g.resolvedAt,
  });

  const photoView = (p: PhotoAttempt & { sessionName?: string | null }) => ({
    id: p.id,
    sessionId: p.sessionId,
    sessionName: p.sessionName !== undefined ? p.sessionName : sessionName(p.sessionId),
    gateId: p.gateId,
    target: p.target,
    status: p.status,
    containsTarget: p.containsTarget,
    confidence: p.confidence,
    reason: p.reason,
    error: p.error,
    hasResized: !!p.resizedFile,
    hasOriginal: !!p.originalFile,
    originalMime: p.originalMime,
    originalBytes: p.originalBytes,
    /** False: stored as uploaded (e.g. HEIC), so EXIF/GPS may still be in it. */
    originalProcessed: p.originalProcessed,
    consentAt: p.consentAt,
    createdAt: p.createdAt,
  });

  /** Maps store errors to 4xx; anything else is a real 500. */
  const handle = (res: Response, fn: () => unknown) => {
    try {
      const result = fn();
      res.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof SessionError || err instanceof PeopleError || err instanceof GateError) {
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
    handle(res, () => {
      const s = sessions.approveClaim(req.params.id);
      gates.personAttached(s.id, s.personSlug!);
      return { session: sessionSummary(s) };
    }),
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
    res.json({
      session: sessionSummary(s),
      messages: sessions.recentMessages(s.id, 1000),
      gates: gates.forSession(s.id).map((g) => gateSummary(g)),
      photos: photos.forSession(s.id).map((p) => photoView(p)),
    });
  });

  router.post('/sessions/:id/assign', (req, res) => {
    const body = AssignBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a person' });
      return;
    }
    handle(res, () => {
      const s = sessions.assignPerson(req.params.id, body.data.slug);
      gates.personAttached(s.id, s.personSlug!);
      return { session: sessionSummary(s) };
    });
  });

  router.post('/sessions/:id/release-name', (req, res) =>
    handle(res, () => ({ session: sessionSummary(sessions.releaseName(req.params.id)) })),
  );

  router.post('/sessions/:id/end', (req, res) => handle(res, () => sessions.end(req.params.id)));

  // --- Gates ----------------------------------------------------------------

  router.get('/gates', (_req, res) => {
    const { defs, errors: defErrors } = gateDefs();
    res.json({ definitions: defs.map(defView), errors: defErrors, active: gates.activeGates().map(gateSummary) });
  });

  router.post('/gates/force', (req, res) => {
    const body = ForceBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    const b = body.data;
    let spec: Parameters<typeof gates.force>[1];
    if (b.key) {
      const def = gateDefs().defs.find((d) => d.key === b.key);
      if (!def) {
        res.status(404).json({ error: 'No such gate. Was gates.json edited?' });
        return;
      }
      spec = { def };
    } else {
      spec = { custom: b.custom! };
    }
    if (b.sessionId && !sessions.get(b.sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const ids = b.all ? sessions.liveNamedIds() : [b.sessionId!];
    const created = gates.force(ids, spec, b.deadlineMinutes ? b.deadlineMinutes * 60_000 : null);
    res.json({ count: created.length });
  });

  router.post('/gates/:id/cancel', (req, res) => handle(res, () => ({ gate: gateSummary(gates.cancel(req.params.id)) })));

  // --- Photos ---------------------------------------------------------------

  router.get('/photos', (_req, res) => {
    res.json({ photos: photos.list().map((p) => photoView(p)) });
  });

  router.get('/photos/:id/:kind', (req, res) => {
    const p = photos.get(req.params.id);
    const kind = req.params.kind;
    const file = p && (kind === 'resized' ? p.resizedFile : kind === 'original' ? p.originalFile : null);
    const abs = photos.filePath(file ?? null);
    if (!p || !abs) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(kind === 'original' && p.originalMime ? p.originalMime : 'image/jpeg');
    if (req.query.download === '1') res.attachment(`${p.id}${abs.slice(abs.lastIndexOf('.'))}`);
    res.sendFile(abs);
  });

  router.delete('/photos/:id', (req, res) => {
    if (!photos.delete(req.params.id)) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- System ---------------------------------------------------------------

  router.get('/system', async (_req, res) => {
    const model = await llm.check();
    res.json({ model, status: llm.status(), pauseReason: settings.get('pauseReason'), listeners: events.connections, errors: errors.recent() });
  });

  /** Closes chat for everyone; guests see `reason`. */
  router.put('/system/pause', (req, res) => {
    const body = PauseBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    llm.pause(body.data.reason);
    res.json({ pauseReason: body.data.reason, status: llm.status() });
  });

  router.delete('/system/pause', (_req, res) => {
    llm.pause(null);
    res.json({ pauseReason: null, status: llm.status() });
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
