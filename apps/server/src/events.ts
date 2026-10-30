/** Receives one live event: an SSE event name and its JSON data. */
export type Listener = (event: string, data: unknown) => void;

/**
 * Routes live events to guests' open /api/events streams. A guest may have
 * several (two tabs), and none while their phone is locked: events are state
 * snapshots, so a reconnecting phone just gets the current state again.
 */
export class EventHub {
  private readonly bySession = new Map<string, Set<Listener>>();

  /** Returns the unsubscribe function. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.bySession.get(sessionId);
    if (!set) this.bySession.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.bySession.get(sessionId) === set) this.bySession.delete(sessionId);
    };
  }

  /** Sessions with at least one open stream. */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }

  isListening(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  toSession(sessionId: string, event: string, data: unknown): void {
    for (const listener of this.bySession.get(sessionId) ?? []) listener(event, data);
  }

  broadcast(event: string, data: unknown): void {
    for (const set of this.bySession.values()) for (const listener of set) listener(event, data);
  }

  /** Open streams, for the admin System screen. */
  get connections(): number {
    let n = 0;
    for (const set of this.bySession.values()) n += set.size;
    return n;
  }
}
