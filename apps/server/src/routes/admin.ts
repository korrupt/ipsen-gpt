import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { GateDef } from '../gateDefs.js';
import { GateError, type Gate } from '../gates.js';
import { allow, clientIp } from '../http.js';
import { PeopleError, type Person } from '../people.js';
import { PersonaError, type EffectivePersona } from '../personas.js';
import { PointsError, type Reward } from '../points.js';
import type { PhotoAttempt } from '../photos.js';
import { SessionError, type Session } from '../sessions.js';
import type { Services } from '../services.js';

const PasswordBody = z.object({ password: z.string().max(500) });
const AssignBody = z.object({ slug: z.string().min(1) });
/** `slug`: who to approve them as, when the claim matches several people (a shared alias). */
const ApproveBody = z.object({ slug: z.string().min(1).optional() });
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
const PersonaId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const PersonBody = z.object({
  name: z.string().max(200),
  aliases: z.array(z.string().max(200)).max(50).default([]),
  info: z.string().max(20_000).default(''),
  /** Omitted: unchanged. null: the global persona. */
  persona: PersonaId.nullable().optional(),
  /** A persona written just for them. Omitted: unchanged. Empty or null: none. */
  customPersona: z.string().max(50_000).nullable().optional(),
});
const PersonaBody = z.object({ id: PersonaId.nullable() });
const PersonaEdit = z.object({
  name: z.string().max(200),
  description: z.string().max(1000).default(''),
  body: z.string().max(50_000),
});
const RulesBody = z.object({ text: z.string().max(50_000) });
const AwardBody = z.object({
  sessionId: z.string().min(1),
  amount: z.number().int().min(-10_000).max(10_000),
  reason: z.string().max(200),
});
const RewardBody = z.object({
  threshold: z.number().int().positive().max(1_000_000),
  prize: z.string().max(200),
  revealed: z.boolean().default(false),
});
// No defaults here: a field left out stays as it is (editing the text must not hide a revealed prize).
const RewardPatch = z
  .object({
    threshold: z.number().int().positive().max(1_000_000).optional(),
    prize: z.string().max(200).optional(),
    revealed: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');

export function adminRouter(config: Config, services: Services): Router {
  const router = Router();
  const { adminAuth, sessions, invites, people, limiter, llm, settings, errors, gates, gateDefs, photos, events, personas, points, pushScores } = services;

  const personName = (slug: string | null) => (slug ? (people.get(slug)?.name ?? `${slug} (deleted)`) : null);

  const sessionSummary = (s: Session & { messageCount?: number }) => ({
    id: s.id,
    name: s.name,
    state: s.state,
    claimCode: s.claimCode,
    person: s.personSlug
      ? { slug: s.personSlug, name: personName(s.personSlug), hasCustomPersona: !!people.get(s.personSlug)?.customPersona }
      : null,
    /** Who a pending claim can be approved as: several for a shared alias, none if all are taken. */
    claimPeople: sessions.claimCandidates(s).map((p) => ({ slug: p.slug, name: p.name })),
    notice: s.notice,
    /** Picked in Sessions; null: none (their person's, else the global one). */
    personaId: s.personaId,
    /** What they get right now and why, and what "no pick" would give them. */
    persona: effectivePersona(s),
    points: points.total(s.id),
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    messageCount: s.messageCount,
  });

  const effectivePersona = (s: Session) => {
    const person = s.state === 'claimed' && s.personSlug ? (people.get(s.personSlug) ?? null) : null;
    try {
      const view = ({ source, id, name }: EffectivePersona) => ({ source, id, name });
      return { now: view(personas.effective(s, person)), withoutPick: view(personas.effective(null, person)) };
    } catch {
      return null; // no persona loads at all; System shows the errors
    }
  };

  const rewardSummary = (r: Reward) => ({ ...r });

  const personView = (p: Person) => ({
    ...p,
    claimedBy: (() => {
      const h = sessions.holderOf(p.slug);
      return h ? { id: h.id, name: h.name } : null;
    })(),
    /** The unused invite link, if any; the client builds the URL from the token. */
    invite: (() => {
      const i = invites.forPerson(p.slug);
      return i ? { token: i.token, createdAt: i.createdAt } : null;
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
      if (
        err instanceof SessionError ||
        err instanceof PeopleError ||
        err instanceof GateError ||
        err instanceof PersonaError ||
        err instanceof PointsError
      ) {
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

  router.post('/claims/:id/approve', (req, res) => {
    const body = ApproveBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'Pick a person' });
      return;
    }
    handle(res, () => {
      const s = sessions.approveClaim(req.params.id, body.data.slug);
      gates.personAttached(s.id, s.personSlug!);
      pushScores(); // the leaderboard shows the new name
      return { session: sessionSummary(s) };
    });
  });

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
      pushScores();
      return { session: sessionSummary(s) };
    });
  });

  router.post('/sessions/:id/release-name', (req, res) =>
    handle(res, () => {
      const s = sessions.releaseName(req.params.id);
      pushScores(); // nameless guests leave the leaderboard
      return { session: sessionSummary(s) };
    }),
  );

  router.post('/sessions/:id/end', (req, res) =>
    handle(res, () => {
      sessions.end(req.params.id);
      pushScores();
    }),
  );

  /** This guest's own persona; `id: null` drops the pick (their person's, else the global one). */
  router.put('/sessions/:id/persona', (req, res) => {
    const body = PersonaBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a persona' });
      return;
    }
    handle(res, () => {
      if (body.data.id !== null && !personas.get(body.data.id)) throw new PersonaError('No such persona.', 404);
      return { session: sessionSummary(sessions.setPersona(req.params.id, body.data.id)) };
    });
  });

  // --- Personas -------------------------------------------------------------

  router.get('/personas', (_req, res) => {
    const { personas: list, errors: loadErrors } = personas.load();
    const ids = new Set(list.map((p) => p.id));
    res.json({
      personas: list.map(({ id, name, description }) => ({ id, name, description })),
      errors: loadErrors,
      activeId: personas.activeId(),
      defaultId: config.chat.defaultPersona,
      /** The shipped personas; `inUse`: one with that id exists (so it can be reset). */
      defaults: personas.defaults().map(({ id, name, description }) => ({ id, name, description, inUse: ids.has(id) })),
    });
  });

  router.get('/personas/rules', (_req, res) => {
    res.json({ text: personas.rules() });
  });

  router.put('/personas/rules', (req, res) => {
    const body = RulesBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid rules' });
      return;
    }
    handle(res, () => ({ text: personas.saveRules(body.data.text) }));
  });

  router.get('/personas/:id', (req, res) =>
    handle(res, () => {
      const p = personas.get(req.params.id);
      if (!p) throw new PersonaError('No such persona.', 404);
      return { persona: p, hasDefault: personas.defaults().some((d) => d.id === p.id) };
    }),
  );

  router.post('/personas', (req, res) => {
    const body = PersonaEdit.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid persona' });
      return;
    }
    handle(res, () => ({ persona: personas.save(body.data) }));
  });

  /** The global persona; `id: null` goes back to the configured default. */
  router.put('/personas/active', (req, res) => {
    const body = PersonaBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a persona' });
      return;
    }
    handle(res, () => {
      personas.setActive(body.data.id);
      return { activeId: personas.activeId() };
    });
  });

  // After /personas/active and /personas/rules, so those paths aren't taken as ids.
  router.put('/personas/:id', (req, res) => {
    const body = PersonaEdit.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid persona' });
      return;
    }
    handle(res, () => ({ persona: personas.save(body.data, req.params.id) }));
  });

  router.delete('/personas/:id', (req, res) => handle(res, () => personas.delete(req.params.id)));

  /** Puts back (or adds) the shipped version of a default persona. */
  router.post('/personas/:id/restore', (req, res) => handle(res, () => ({ persona: personas.restoreDefault(req.params.id) })));

  // --- Points & rewards -----------------------------------------------------

  router.get('/points', (_req, res) => {
    res.json({ leaderboard: points.leaderboard(), rewards: points.rewards().map(rewardSummary), recent: points.recent(50) });
  });

  /** Gives (or with a negative amount, takes) points, with a reason the guest sees. */
  router.post('/points', (req, res) => {
    const body = AwardBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    handle(res, () => {
      const s = sessions.get(body.data.sessionId);
      if (!s) throw new PointsError('Session not found', 404);
      const entry = points.award(s.id, body.data.amount, body.data.reason, 'admin');
      events.toSession(s.id, 'points_awarded', { amount: entry.amount, reason: entry.reason });
      return { entry, total: points.total(s.id) };
    });
  });

  router.post('/rewards', (req, res) => {
    const body = RewardBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid reward' });
      return;
    }
    handle(res, () => ({ reward: rewardSummary(points.addReward(body.data)) }));
  });

  /** Edit a reward, or show/hide its prize with `{ revealed }`. */
  router.patch('/rewards/:id', (req, res) => {
    const body = RewardPatch.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid reward' });
      return;
    }
    handle(res, () => ({ reward: rewardSummary(points.updateReward(req.params.id, body.data)) }));
  });

  router.delete('/rewards/:id', (req, res) => handle(res, () => points.deleteReward(req.params.id)));

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
    sessions.peopleReloaded();
    res.json({ people: people.list().map(personView), errors: people.errors });
  });

  const checkPersona = (id: string | null | undefined) => {
    if (id && !personas.get(id)) throw new PersonaError('No such persona.', 404);
  };

  router.post('/people', (req, res) => {
    const body = PersonBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid person' });
      return;
    }
    handle(res, () => {
      checkPersona(body.data.persona);
      return { person: personView(people.save(body.data)) };
    });
  });

  router.put('/people/:slug', (req, res) => {
    const body = PersonBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid person' });
      return;
    }
    handle(res, () => {
      checkPersona(body.data.persona);
      const saved = people.save(body.data, req.params.slug);
      sessions.personUpdated(saved);
      return { person: personView(saved) };
    });
  });

  router.delete('/people/:slug', (req, res) =>
    handle(res, () => {
      people.delete(req.params.slug);
      sessions.personDeleted(req.params.slug);
      invites.revoke(req.params.slug);
    }),
  );

  /** A new single-use invite link for this person (their previous unused one stops working). */
  router.post('/people/:slug/invite', (req, res) =>
    handle(res, () => {
      const person = people.get(req.params.slug);
      if (!person) throw new PeopleError('No such person.', 404);
      invites.create(person.slug);
      return { person: personView(person) };
    }),
  );

  router.delete('/people/:slug/invite', (req, res) =>
    handle(res, () => {
      const person = people.get(req.params.slug);
      if (!person) throw new PeopleError('No such person.', 404);
      invites.revoke(person.slug);
      return { person: personView(person) };
    }),
  );

  return router;
}
