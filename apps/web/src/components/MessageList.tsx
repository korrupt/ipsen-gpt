import { useRef } from 'react';
import { useStickToBottom } from '../hooks/useStickToBottom';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'done' | 'error' | 'stopped';
}

interface Props {
  messages: Message[];
  onRetry: () => void;
}

export function MessageList({ messages, onRetry }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  // Re-run auto-scroll on every new message and every streamed token.
  const userCount = messages.filter((m) => m.role === 'user').length;
  const { onScroll, scrollToBottom, atBottom } = useStickToBottom(
    ref,
    `${messages.length}:${last?.content.length}`,
    userCount,
  );

  if (messages.length === 0) {
    return (
      <main className="messages">
        <div className="empty">
          <div className="portrait" aria-hidden="true" />
          <h2 className="empty__title">What can I haunt for you?</h2>
        </div>
      </main>
    );
  }

  return (
    <main className="messages" ref={ref} onScroll={onScroll} aria-live="polite">
      <div className="messages__inner">
        {messages.filter((m) => !(m.status === 'stopped' && !m.content)).map((m) => (
          <div
            key={m.id}
            className={`msg msg--${m.role}${m.status === 'error' ? ' msg--error' : ''}`}
            data-testid={`msg-${m.role}`}
          >
            {m.content}
            {m.status === 'streaming' && <span className="cursor" aria-label="IpsenGPT is typing" />}
            {m.status === 'error' && m.id === last?.id && (
              <div className="msg__actions">
                <button type="button" className="link-button" onClick={onRetry}>
                  Try again
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {!atBottom && (
        <button type="button" className="scroll-down" aria-label="Scroll to bottom" onClick={() => scrollToBottom('smooth')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      )}
    </main>
  );
}
