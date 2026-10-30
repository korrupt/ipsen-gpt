import type { Scoreboard, Standing } from './events';
import type { GateView } from './photos';

const TOKEN_KEY = 'ipsengpt.token';

export type SessionState = 'guest' | 'pending_claim' | 'claimed';

export interface SessionView {
  name: string | null;
  state: SessionState;
  claimCode: string | null;
  notice: string | null;
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/** The session no longer exists (ended by admin, or the token is unknown). */
export class SessionGoneError extends Error {}

/** A request failed with a message meant for the guest. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const NETWORK_ERROR = 'SadGPT could not reach the server. Check your connection and try again.';

// localStorage can throw (private mode, blocked storage); the app still works for this page load.
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Throws SessionGoneError on 401 and ApiError on other failures. */
export async function checkResponse(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) {
    setToken(null);
    throw new SessionGoneError();
  }
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  throw new ApiError(body?.error ?? NETWORK_ERROR, res.status, body?.code);
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }
  await checkResponse(res);
  return (await res.json()) as T;
}

export async function createSession(name: string): Promise<{ session: SessionView; gate: GateView | null }> {
  const { token, session, gate } = await request<{ token: string; session: SessionView; gate: GateView | null }>(
    'POST',
    '/api/session',
    { name },
  );
  setToken(token);
  return { session, gate: gate ?? null };
}

/**
 * Opens an invite link (`/#invite=<token>`): the guest becomes that person at
 * once. Sends the current token, if any, so that session is the one that changes.
 */
export async function redeemInvite(invite: string): Promise<void> {
  const { token } = await request<{ token: string | null }>('POST', '/api/invite', { token: invite });
  if (token) setToken(token);
}

/** The invite token in the URL (`#invite=...`), if this page was opened from an invite link. */
export function inviteFromUrl(hash = window.location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('invite') || null;
}

/** Removes the invite from the address bar, so a reload or a shared screenshot doesn't carry it. */
export function clearInviteFromUrl(): void {
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // ignore
  }
}

export function fetchSession(): Promise<{ session: SessionView; messages: HistoryItem[]; gate?: GateView | null }> {
  return request('GET', '/api/session');
}

/** The leaderboard and rewards (prizes hidden until revealed) and the guest's own standing. */
export function fetchLeaderboard(): Promise<Scoreboard & { me: Standing }> {
  return request('GET', '/api/leaderboard');
}

export async function chooseName(name: string): Promise<SessionView> {
  return (await request<{ session: SessionView }>('PUT', '/api/session/name', { name })).session;
}
