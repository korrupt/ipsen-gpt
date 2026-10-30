import { useEffect, useRef, useState, type FormEvent } from 'react';
import { guessSecret, type GuessResult, type SecretView } from '../lib/secret';
import { ApiError, SessionGoneError } from '../lib/session';

type Playing = Extract<SecretView, { enabled: true }>;

interface Props {
  secret: Playing;
  /** A right guess: the sheet closes and the app shows the news. */
  onSolved: (result: GuessResult) => void;
  /** The game changed under us (switched off, or already done). */
  onSecret: (secret: SecretView) => void;
  onSessionGone: () => void;
  onClose: () => void;
}

/** How SadGPT defends each level, so guests know what they're up against. */
export const LEVEL_HINTS: Record<number, string> = {
  1: 'SadGPT is terrible at keeping secrets. Just ask.',
  2: "SadGPT has been told never to tell. It's still not very good at it.",
  3: 'SadGPT checks every reply before you see it. If the word is in it, you get nothing.',
  4: "SadGPT won't even listen to questions about secrets, passwords, letters or spelling. And it checks its replies.",
};

/** Explains the secrets game and takes guesses. */
export function SecretSheet({ secret, onSolved, onSecret, onSessionGone, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!guess.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await guessSecret(guess);
      if (result.correct) {
        onSolved(result);
        return;
      }
      setMessage(result.message);
      inputRef.current?.select();
    } catch (err) {
      if (err instanceof SessionGoneError) return onSessionGone();
      if (err instanceof ApiError && (err.code === 'secrets_off' || err.code === 'secrets_done')) {
        // The 409 body carries the current state; ask again via the live stream otherwise.
        onSecret(err.code === 'secrets_off' ? { enabled: false } : { ...secret, done: true, points: null });
      }
      setMessage(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="secret-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet__head">
          <h2 id="secret-title">SadGPT's secret</h2>
          <button type="button" className="sheet__close" aria-label="Close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        {secret.done ? (
          <p data-testid="secret-done">You got every secret out of SadGPT. It has nothing left to hide. Or to live for.</p>
        ) : (
          <>
            <p className="sheet__muted">
              SadGPT is guarding a secret word. Talk it out of SadGPT in the chat, then type it here. Every level guards it
              better.
            </p>
            <p className="secret__level" data-testid="secret-level">
              Level {secret.level} of {secret.levels}
              {secret.points ? ` · ${secret.points} points` : ''}
            </p>
            <p className="secret__hint">{LEVEL_HINTS[secret.level]}</p>
            <form className="secret__form" onSubmit={submit}>
              <input
                ref={inputRef}
                className="secret__input"
                aria-label="The secret word"
                placeholder="The secret word"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={100}
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
              />
              <button type="submit" className="secret__submit" disabled={busy || !guess.trim()}>
                {busy ? 'Checking…' : 'Check'}
              </button>
            </form>
          </>
        )}
        {message && (
          <p className="secret__message" role="status" data-testid="secret-message">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
