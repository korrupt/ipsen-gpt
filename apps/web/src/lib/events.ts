import type { GateView } from './photos';
import type { SecretView } from './secret';
import { authHeaders, checkResponse, SessionGoneError } from './session';
import { SseParser } from './sse';

/** Whether guests can chat right now, and if not, what they are told. */
export interface ChatStatus {
  open: boolean;
  reason: 'paused' | 'disconnected' | null;
  message: string | null;
}

export const OPEN: ChatStatus = { open: true, reason: null, message: null };

/** The guest's own score and place (null: not on the leaderboard yet). */
export interface Standing {
  points: number;
  rank: number | null;
}

/** "First to <threshold> points". `prize` is null until the host reveals it. */
export interface GuestReward {
  id: string;
  threshold: number;
  prize: string | null;
  winner: string | null;
}

export interface Scoreboard {
  top: { rank: number; name: string; points: number }[];
  rewards: GuestReward[];
}

export interface LiveHandlers {
  onStatus: (status: ChatStatus) => void;
  /** The gate blocking chat now, or null. */
  onGate: (gate: GateView | null) => void;
  onSessionGone: () => void;
  onStanding?: (standing: Standing) => void;
  onScoreboard?: (board: Scoreboard) => void;
  /** This guest just won a reward. */
  onRewardWon?: (reward: GuestReward) => void;
  /** The host gave (or took) this guest points. */
  onPointsAwarded?: (award: { amount: number; reason: string }) => void;
  /** The guest's secrets game: on/off, level. */
  onSecret?: (secret: SecretView) => void;
}

/** Waits between reconnects: 1 s, 2 s, 4 s ... up to 15 s; back to 1 s after a good connection. */
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Keeps GET /api/events open and reconnects when it drops (phone locked,
 * network blip, server restart). Every event is a full snapshot, so nothing is
 * lost in between. Uses fetch, not EventSource, so the token stays in a header
 * instead of the URL. Returns a function that stops it.
 */
export function connectEvents(handlers: LiveHandlers): () => void {
  const stop = new AbortController();
  void (async () => {
    let attempt = 0;
    while (!stop.signal.aborted) {
      try {
        const res = await fetch('/api/events', { headers: { ...authHeaders(), accept: 'text/event-stream' }, signal: stop.signal });
        await checkResponse(res);
        if (!res.body) throw new Error('no body');
        const parser = new SseParser(({ event, data }) => {
          attempt = 0;
          const value: unknown = JSON.parse(data);
          if (event === 'status') handlers.onStatus(value as ChatStatus);
          else if (event === 'gate') handlers.onGate((value as { gate: GateView | null }).gate);
          else if (event === 'points') handlers.onStanding?.(value as Standing);
          else if (event === 'scoreboard') handlers.onScoreboard?.(value as Scoreboard);
          else if (event === 'reward_won') handlers.onRewardWon?.(value as GuestReward);
          else if (event === 'points_awarded') handlers.onPointsAwarded?.(value as { amount: number; reason: string });
          else if (event === 'secret') handlers.onSecret?.(value as SecretView);
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(value);
        }
      } catch (err) {
        if (stop.signal.aborted) return;
        if (err instanceof SessionGoneError) {
          handlers.onSessionGone();
          return;
        }
      }
      await sleep(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, stop.signal);
    }
  })();
  return () => stop.abort();
}

/** "First to 50 points" */
export const rewardGoal = (r: GuestReward) => `First to ${r.threshold} points`;
