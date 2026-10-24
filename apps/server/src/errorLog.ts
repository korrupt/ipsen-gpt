export interface ErrorEntry {
  at: number;
  message: string;
  detail: string;
}

/** The last few errors, for the admin System screen. In memory only. */
export class ErrorLog {
  private entries: ErrorEntry[] = [];

  constructor(
    private readonly max = 50,
    private readonly now: () => number = Date.now,
  ) {}

  add(message: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err === undefined ? '' : String(err);
    this.entries.push({ at: this.now(), message, detail });
    if (this.entries.length > this.max) this.entries.shift();
  }

  /** Newest first. */
  recent(): ErrorEntry[] {
    return [...this.entries].reverse();
  }
}
