import { useEffect, useRef, useState } from 'react';
import { resizeForVerify, uploadOriginal, verifyPhoto, type GateView, type VerifyResult } from '../lib/photos';
import { ApiError, SessionGoneError } from '../lib/session';

interface Props {
  gate: GateView;
  /** Every verdict (and "that gate is closed"); the app moves on to the next gate. */
  onResult: (result: VerifyResult) => void;
  onSessionGone: () => void;
  /** The deadline passed: ask the server what's next. */
  onExpired: () => void;
}

export const TEXT_GATE_HINT = 'Answer in the chat below. SadGPT judges every message until one is good enough.';

export const CONSENT_LABEL = "I'm responsible for this photo and it may be shared after the party";
export const UNREADABLE_PHOTO = "Couldn't read that photo. Try another one.";

interface Feedback {
  tone: 'failed' | 'unverified' | 'error';
  text: string;
  reason?: string | null;
}

/** Seconds left until `deadlineAt`, ticking once a second; null without a deadline. */
function useSecondsLeft(deadlineAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadlineAt]);
  return deadlineAt === null ? null : Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Shown while a photo gate blocks the chat: SadGPT's demand, a consent
 * checkbox, and the camera button. Only the server decides whether a photo passes.
 */
export function GatePanel({ gate, onResult, onSessionGone, onExpired }: Props) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const secondsLeft = useSecondsLeft(gate.deadlineAt);

  useEffect(() => setFeedback(null), [gate.id]);

  // Ask again every few seconds in case the phone's clock runs ahead of the server's.
  const expired = secondsLeft === 0;
  useEffect(() => {
    if (!expired) return;
    onExpired();
    const timer = setInterval(onExpired, 5000);
    return () => clearInterval(timer);
  }, [expired, onExpired]);

  const onFile = async (file: File) => {
    setBusy(true);
    setFeedback(null);
    try {
      let small: Blob;
      try {
        small = await resizeForVerify(file);
      } catch {
        setFeedback({ tone: 'error', text: UNREADABLE_PHOTO });
        return;
      }
      const r = await verifyPhoto(gate.id, small);
      if (r.kind === 'verdict') {
        // Every attempt goes to the album, in the background.
        void uploadOriginal(r.attemptId, file);
        if (r.result !== 'passed') setFeedback({ tone: r.result, text: r.message, reason: r.reason });
      }
      onResult(r);
    } catch (err) {
      if (err instanceof SessionGoneError) onSessionGone();
      else setFeedback({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (gate.kind === 'text') {
    return (
      <section className="gate" aria-label="Challenge">
        <div className="gate__box">
          <div className="gate__head">
            <div className="portrait gate__portrait" aria-hidden="true" />
            <p className="gate__prompt">{gate.prompt}</p>
          </div>
          {secondsLeft !== null && (
            <p className="gate__deadline" data-testid="gate-deadline">
              {mmss(secondsLeft)} left
            </p>
          )}
          <p className="gate__hint" data-testid="gate-text-hint">
            {TEXT_GATE_HINT}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="gate" aria-label="Photo challenge">
      <div className="gate__box">
        <div className="gate__head">
          <div className="portrait gate__portrait" aria-hidden="true" />
          <p className="gate__prompt">{gate.prompt}</p>
        </div>
        {secondsLeft !== null && (
          <p className="gate__deadline" data-testid="gate-deadline">
            {mmss(secondsLeft)} left
          </p>
        )}
        <label className="gate__consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{CONSENT_LABEL}</span>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="gate-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // so the same photo can be picked again
            if (file) void onFile(file);
          }}
        />
        <button type="button" className="gate__button" disabled={!consent || busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'SadGPT is studying your photo…' : 'Take photo'}
        </button>
        {feedback && (
          <div className={`gate__feedback gate__feedback--${feedback.tone}`} role="status">
            <p>{feedback.text}</p>
            {feedback.reason && <p className="gate__reason">SadGPT saw: {feedback.reason}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
