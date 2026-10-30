export type SessionState = 'guest' | 'pending_claim' | 'claimed';

export interface AdminSession {
  id: string;
  name: string | null;
  state: SessionState;
  claimCode: string | null;
  /** `hasCustomPersona`: you wrote a persona just for them (People). */
  person: { slug: string; name: string; hasCustomPersona?: boolean } | null;
  /** Who a pending claim can be approved as: several for a shared alias, none if all are taken. */
  claimPeople: { slug: string; name: string }[];
  notice: string | null;
  /** This guest's own persona; null: the global one. */
  personaId: string | null;
  points: number;
  createdAt: number;
  lastSeenAt: number;
  messageCount?: number;
}

export interface PersonaInfo {
  id: string;
  name: string;
  description: string;
}

export interface Personas {
  personas: PersonaInfo[];
  errors: string[];
  /** The global persona. */
  activeId: string;
  defaultId: string;
  /** The shipped personas; `inUse`: one with that id exists. */
  defaults: (PersonaInfo & { inUse: boolean })[];
}

export interface PersonaEdit {
  name: string;
  description: string;
  /** The character text. */
  body: string;
}

export interface AdminReward {
  id: string;
  threshold: number;
  prize: string;
  revealed: boolean;
  winnerId: string | null;
  winnerName: string | null;
  wonAt: number | null;
  createdAt: number;
}

export interface PointsOverview {
  leaderboard: { rank: number; sessionId: string; name: string; points: number }[];
  rewards: AdminReward[];
  recent: { id: number; sessionId: string; sessionName: string | null; amount: number; reason: string; source: 'gate' | 'admin'; createdAt: number }[];
}

export interface AdminMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface AdminPerson {
  slug: string;
  name: string;
  aliases: string[];
  info: string;
  /** Persona their session gets when approved; null: the global one. */
  persona: string | null;
  /** A persona written just for them; used instead of `persona`. */
  customPersona: string | null;
  claimedBy: { id: string; name: string | null } | null;
  /** The unused single-use invite link, if any. */
  invite: { token: string; createdAt: number } | null;
}

export interface PersonInput {
  name: string;
  aliases: string[];
  info: string;
  persona: string | null;
  customPersona: string | null;
}

export interface ProbeResult {
  url: string;
  model: string;
  reachable: boolean;
  hasModel: boolean;
  error: string | null;
}

export interface ChatStatus {
  open: boolean;
  reason: 'paused' | 'disconnected' | null;
  message: string | null;
}

export interface SystemStatus {
  /** Checked live when the System tab asks. */
  model: ProbeResult & { checkedAt: number | null };
  /** What guests see right now. */
  status: ChatStatus;
  pauseReason: string | null;
  /** Open live-event streams (roughly: guests with the page open). */
  listeners: number;
  errors: { at: number; message: string; detail: string }[];
}

export type GateTrigger =
  | { type: 'session_start' }
  | { type: 'after_messages'; count: number }
  | { type: 'curse_break' }
  | { type: 'secret_level'; level: number }
  | { type: 'admin_forced' }
  | { type: 'timed_global'; at: string; deadline_minutes: number };

export interface GateDefinition {
  key: string;
  id: string;
  person: { slug: string; name: string } | null;
  target: string;
  guestPrompt: string;
  refusalLines: string[];
  points: number;
  trigger: GateTrigger;
}

export type GateStatus = 'active' | 'passed' | 'expired' | 'cancelled';

export interface AdminGate {
  id: string;
  sessionId: string;
  sessionName: string | null;
  defKey: string | null;
  source: 'session_start' | 'after_messages' | 'admin_forced' | 'timed_global';
  target: string;
  guestPrompt: string;
  points: number;
  status: GateStatus;
  refusals: number;
  createdAt: number;
  deadlineAt: number | null;
  resolvedAt: number | null;
}

export type PhotoStatus = 'verifying' | 'passed' | 'failed' | 'unverified';

export interface AdminPhoto {
  id: string;
  sessionId: string;
  sessionName: string | null;
  gateId: string | null;
  target: string;
  status: PhotoStatus;
  containsTarget: boolean | null;
  confidence: number | null;
  reason: string | null;
  error: string | null;
  hasResized: boolean;
  hasOriginal: boolean;
  originalMime: string | null;
  originalBytes: number | null;
  /** False: stored as uploaded (e.g. HEIC); EXIF/GPS may still be in it. */
  originalProcessed: boolean | null;
  consentAt: number;
  createdAt: number;
}

export interface ForceGateInput {
  sessionId?: string;
  all?: true;
  key?: string;
  custom?: { target: string; guestPrompt: string };
  deadlineMinutes?: number;
}

let onUnauthorized: () => void = () => {};
/** Called whenever the server says we're not logged in. */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class AdminApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AdminApiError('Network error. Check the connection.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== '/login') {
    onUnauthorized();
    throw new AdminApiError('Logged out');
  }
  if (!res.ok) throw new AdminApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const adminApi = {
  me: () => call<{ ok: true }>('GET', '/me'),
  login: (password: string) => call<{ ok: true }>('POST', '/login', { password }),
  logout: () => call<{ ok: true }>('POST', '/logout', {}),

  claims: () => call<{ claims: AdminSession[] }>('GET', '/claims').then((r) => r.claims),
  /** `slug`: who to approve them as, when the claim matches several people. */
  approve: (id: string, slug?: string) =>
    call<{ session: AdminSession }>('POST', `/claims/${id}/approve`, slug ? { slug } : {}).then((r) => r.session),
  reject: (id: string) => call<{ session: AdminSession }>('POST', `/claims/${id}/reject`, {}).then((r) => r.session),

  sessions: () => call<{ sessions: AdminSession[] }>('GET', '/sessions').then((r) => r.sessions),
  session: (id: string) =>
    call<{ session: AdminSession; messages: AdminMessage[]; gates: AdminGate[]; photos: AdminPhoto[] }>(
      'GET',
      `/sessions/${id}`,
    ),
  assign: (id: string, slug: string) =>
    call<{ session: AdminSession }>('POST', `/sessions/${id}/assign`, { slug }).then((r) => r.session),
  releaseName: (id: string) =>
    call<{ session: AdminSession }>('POST', `/sessions/${id}/release-name`, {}).then((r) => r.session),
  endSession: (id: string) => call<{ ok: true }>('POST', `/sessions/${id}/end`, {}),
  setSessionPersona: (id: string, personaId: string | null) =>
    call<{ session: AdminSession }>('PUT', `/sessions/${id}/persona`, { id: personaId }).then((r) => r.session),

  personas: () => call<Personas>('GET', '/personas'),
  setActivePersona: (id: string | null) => call<{ activeId: string }>('PUT', '/personas/active', { id }),
  persona: (id: string) => call<{ persona: PersonaInfo & { body: string }; hasDefault: boolean }>('GET', `/personas/${id}`),
  createPersona: (p: PersonaEdit) => call<{ persona: PersonaInfo }>('POST', '/personas', p).then((r) => r.persona),
  updatePersona: (id: string, p: PersonaEdit) => call<{ persona: PersonaInfo }>('PUT', `/personas/${id}`, p).then((r) => r.persona),
  deletePersona: (id: string) => call<{ ok: true }>('DELETE', `/personas/${id}`),
  restorePersona: (id: string) => call<{ persona: PersonaInfo }>('POST', `/personas/${id}/restore`, {}).then((r) => r.persona),
  personaRules: () => call<{ text: string }>('GET', '/personas/rules').then((r) => r.text),
  savePersonaRules: (text: string) => call<{ text: string }>('PUT', '/personas/rules', { text }).then((r) => r.text),

  points: () => call<PointsOverview>('GET', '/points'),
  award: (sessionId: string, amount: number, reason: string) =>
    call<{ total: number }>('POST', '/points', { sessionId, amount, reason }),
  addReward: (threshold: number, prize: string, revealed: boolean) =>
    call<{ reward: AdminReward }>('POST', '/rewards', { threshold, prize, revealed }).then((r) => r.reward),
  updateReward: (id: string, patch: Partial<Pick<AdminReward, 'threshold' | 'prize' | 'revealed'>>) =>
    call<{ reward: AdminReward }>('PATCH', `/rewards/${id}`, patch).then((r) => r.reward),
  deleteReward: (id: string) => call<{ ok: true }>('DELETE', `/rewards/${id}`),

  system: () => call<SystemStatus>('GET', '/system'),
  pause: (reason: string) => call<{ pauseReason: string; status: ChatStatus }>('PUT', '/system/pause', { reason }),
  resume: () => call<{ pauseReason: null; status: ChatStatus }>('DELETE', '/system/pause'),

  gates: () => call<{ definitions: GateDefinition[]; errors: string[]; active: AdminGate[] }>('GET', '/gates'),
  forceGate: (input: ForceGateInput) => call<{ count: number }>('POST', '/gates/force', input),
  cancelGate: (id: string) => call<{ gate: AdminGate }>('POST', `/gates/${id}/cancel`, {}),

  photos: () => call<{ photos: AdminPhoto[] }>('GET', '/photos').then((r) => r.photos),
  deletePhoto: (id: string) => call<{ ok: true }>('DELETE', `/photos/${id}`),

  people: () => call<{ people: AdminPerson[]; errors: string[] }>('GET', '/people'),
  reloadPeople: () => call<{ people: AdminPerson[]; errors: string[] }>('POST', '/people/reload', {}),
  createPerson: (p: PersonInput) => call<{ person: AdminPerson }>('POST', '/people', p).then((r) => r.person),
  updatePerson: (slug: string, p: PersonInput) =>
    call<{ person: AdminPerson }>('PUT', `/people/${slug}`, p).then((r) => r.person),
  deletePerson: (slug: string) => call<{ ok: true }>('DELETE', `/people/${slug}`),
  createInvite: (slug: string) => call<{ person: AdminPerson }>('POST', `/people/${slug}/invite`, {}).then((r) => r.person),
  revokeInvite: (slug: string) => call<{ person: AdminPerson }>('DELETE', `/people/${slug}/invite`).then((r) => r.person),
};

/** The link a guest opens to join as this person (the token stays out of server logs, after the #). */
export const inviteUrl = (token: string, origin = window.location.origin) => `${origin}/#invite=${token}`;

/** "just now", "3 min ago", "2 h ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** Same loose matching as the server: "bat 427" finds BAT-427. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Where an admin photo can be viewed (same-origin, cookie-authenticated). */
export const photoUrl = (id: string, kind: 'resized' | 'original', download = false) =>
  `/api/admin/photos/${id}/${kind}${download ? '?download=1' : ''}`;

/** "after 3 messages", "at 22:30 for 10 min", ... */
export function triggerLabel(t: GateTrigger): string {
  switch (t.type) {
    case 'session_start':
      return 'when they start';
    case 'after_messages':
      return `after ${t.count} message${t.count === 1 ? '' : 's'}`;
    case 'curse_break':
      return 'to break a curse';
    case 'secret_level':
      return `before secret level ${t.level}`;
    case 'admin_forced':
      return 'only when forced';
    case 'timed_global': {
      const at = new Date(t.at).toLocaleString('nb-NO', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      return `everyone at ${at}, ${t.deadline_minutes} min`;
    }
  }
}

export const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  active: 'Active',
  passed: 'Passed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const PHOTO_STATUS_LABELS: Record<PhotoStatus, string> = {
  verifying: 'Checking',
  passed: 'Passed',
  failed: 'Failed',
  unverified: 'Unverified',
};

export const STATE_LABELS: Record<SessionState, string> = {
  guest: 'Guest',
  pending_claim: 'Pending',
  claimed: 'Claimed',
};
