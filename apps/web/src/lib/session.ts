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

export const NETWORK_ERROR = 'The spirits could not reach the server. Check your connection and try again.';

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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
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

export async function createSession(name: string): Promise<SessionView> {
  const { token, session } = await request<{ token: string; session: SessionView }>('POST', '/api/session', { name });
  setToken(token);
  return session;
}

export function fetchSession(): Promise<{ session: SessionView; messages: HistoryItem[] }> {
  return request('GET', '/api/session');
}

export async function chooseName(name: string): Promise<SessionView> {
  return (await request<{ session: SessionView }>('PUT', '/api/session/name', { name })).session;
}
