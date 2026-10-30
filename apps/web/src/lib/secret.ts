import type { GateView } from './photos';
import { request } from './session';

/** The guest's secrets game. Never the word: that only lives on the server. */
export type SecretView =
  | { enabled: false }
  | { enabled: true; level: number; levels: number; done: boolean; points: number | null };

export interface GuessResult {
  correct: boolean;
  /** What SadGPT says about the guess. */
  message: string;
  /** Points just won (0 when wrong). */
  points: number;
  secret: SecretView;
  /** A photo gate the new level starts with. */
  gate?: GateView | null;
}

/** Throws ApiError: 429 when guessing too fast, 409 when the game is off or done. */
export function guessSecret(guess: string): Promise<GuessResult> {
  return request('POST', '/api/secret', { guess });
}
