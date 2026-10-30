import { useEffect } from 'react';

export const TOAST_MS = 5000;

/** A short notice over the chat (points awarded, a reward won); goes away by itself or on tap. */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, onDone]);
  return (
    <button type="button" className="toast" role="status" data-testid="toast" onClick={onDone}>
      {message}
    </button>
  );
}
