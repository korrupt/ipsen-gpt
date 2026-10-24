export type SessionState = 'guest' | 'pending_claim' | 'claimed';

export interface AdminSession {
  id: string;
  name: string | null;
  state: SessionState;
  claimCode: string | null;
  person: { slug: string; name: string } | null;
  claimPerson: { slug: string; name: string } | null;
  notice: string | null;
  createdAt: number;
  lastSeenAt: number;
  messageCount?: number;
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
  claimedBy: { id: string; name: string | null } | null;
}

export interface PersonInput {
  name: string;
  aliases: string[];
  info: string;
}

export interface ProbeResult {
  url: string;
  model: string;
  reachable: boolean;
  hasModel: boolean;
  error: string | null;
}

export interface SystemStatus {
  llm: {
    forceFallback: boolean;
    lastUsed: 'primary' | 'fallback' | null;
    primarySkippedUntil: number | null;
    primary: ProbeResult;
    fallback: ProbeResult | null;
  };
  errors: { at: number; message: string; detail: string }[];
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
  approve: (id: string) => call<{ session: AdminSession }>('POST', `/claims/${id}/approve`, {}).then((r) => r.session),
  reject: (id: string) => call<{ session: AdminSession }>('POST', `/claims/${id}/reject`, {}).then((r) => r.session),

  sessions: () => call<{ sessions: AdminSession[] }>('GET', '/sessions').then((r) => r.sessions),
  session: (id: string) => call<{ session: AdminSession; messages: AdminMessage[] }>('GET', `/sessions/${id}`),
  assign: (id: string, slug: string) =>
    call<{ session: AdminSession }>('POST', `/sessions/${id}/assign`, { slug }).then((r) => r.session),
  releaseName: (id: string) =>
    call<{ session: AdminSession }>('POST', `/sessions/${id}/release-name`, {}).then((r) => r.session),
  endSession: (id: string) => call<{ ok: true }>('POST', `/sessions/${id}/end`, {}),

  system: () => call<SystemStatus>('GET', '/system'),
  setForceFallback: (enabled: boolean) =>
    call<{ forceFallback: boolean }>('POST', '/system/force-fallback', { enabled }),

  people: () => call<{ people: AdminPerson[]; errors: string[] }>('GET', '/people'),
  reloadPeople: () => call<{ people: AdminPerson[]; errors: string[] }>('POST', '/people/reload', {}),
  createPerson: (p: PersonInput) => call<{ person: AdminPerson }>('POST', '/people', p).then((r) => r.person),
  updatePerson: (slug: string, p: PersonInput) =>
    call<{ person: AdminPerson }>('PUT', `/people/${slug}`, p).then((r) => r.person),
  deletePerson: (slug: string) => call<{ ok: true }>('DELETE', `/people/${slug}`),
};

/** "just now", "3 min ago", "2 h ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** Same loose matching as the server: "bat 427" finds BAT-427. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const STATE_LABELS: Record<SessionState, string> = {
  guest: 'Guest',
  pending_claim: 'Pending',
  claimed: 'Claimed',
};
