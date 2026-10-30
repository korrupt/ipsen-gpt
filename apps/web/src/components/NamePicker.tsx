import { useState, type FormEvent } from 'react';

interface Props {
  notice: string | null;
  onSubmit: (name: string) => Promise<string | null>;
}

export const NAME_MAX_LENGTH = 24;

/** First screen: guests choose what SadGPT calls them. */
export function NamePicker({ notice, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(await onSubmit(name.trim()));
    setBusy(false);
  };

  return (
    <main className="messages">
      <form className="empty name-picker" onSubmit={submit}>
        <div className="portrait" aria-hidden="true" />
        <h2 className="empty__title">What should I call you?</h2>
        {notice && (
          <p className="name-picker__notice" role="status">
            {notice}
          </p>
        )}
        <div className="composer__box name-picker__box">
          <input
            className="composer__input"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Your name"
            aria-label="Your name"
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="go"
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="composer__send" disabled={!name.trim() || busy} aria-label="Start chatting">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        {error && (
          <p className="name-picker__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
