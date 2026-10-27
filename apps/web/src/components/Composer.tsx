import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_INPUT_CHARS } from '../lib/chatApi';

interface Props {
  streaming: boolean;
  /** Chat is closed (PC unreachable or paused): nothing can be sent, but typed text is kept. */
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

const COUNTER_FROM = MAX_INPUT_CHARS - 100;

/** Touch devices: Enter inserts a newline, like the ChatGPT app. */
const isCoarsePointer = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

export function Composer({ streaming, disabled = false, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !streaming && !disabled && text.trim().length > 0 && text.length <= MAX_INPUT_CHARS;

  // Grow with content up to the CSS max-height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (streaming) {
      onStop();
      return;
    }
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isCoarsePointer()) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer__box">
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          maxLength={MAX_INPUT_CHARS}
          placeholder={disabled ? 'Chat is closed right now' : 'Ask IpsenGPT anything'}
          aria-label="Message IpsenGPT"
          disabled={disabled && !streaming}
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="composer__send"
          disabled={!streaming && !canSend}
          aria-label={streaming ? 'Stop generating' : 'Send message'}
        >
          {streaming ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect width="14" height="14" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
      <div className="composer__meta">
        {text.length >= COUNTER_FROM ? (
          <span className={`composer__count${text.length >= MAX_INPUT_CHARS ? ' composer__count--over' : ''}`} data-testid="char-count">
            {text.length} / {MAX_INPUT_CHARS}
          </span>
        ) : (
          <span>IpsenGPT can make mistakes. Some of them are on purpose.</span>
        )}
      </div>
    </form>
  );
}
