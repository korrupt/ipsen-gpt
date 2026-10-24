import { useCallback, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { MessageList, type Message } from './components/MessageList';
import { useVisualViewport } from './hooks/useVisualViewport';
import { ChatError, sendChat, type HistoryItem } from './lib/chatApi';

let nextId = 0;
const newId = () => `m${++nextId}`;

/** What we send as context: finished exchanges only, no failed replies. */
function toHistory(messages: Message[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && (m.status === 'error' || !m.content)) {
      if (out.at(-1)?.role === 'user') out.pop();
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function App() {
  useVisualViewport();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patchLast = (patch: (m: Message) => Partial<Message>) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      return last ? [...ms.slice(0, -1), { ...last, ...patch(last) }] : ms;
    });

  const send = useCallback(async (text: string, prior: Message[]) => {
    const history = toHistory(prior);
    setMessages([
      ...prior,
      { id: newId(), role: 'user', content: text, status: 'done' },
      { id: newId(), role: 'assistant', content: '', status: 'streaming' },
    ]);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await sendChat(text, history, (t) => patchLast((m) => ({ content: m.content + t })), abort.signal);
      patchLast(() => ({ status: 'done' }));
    } catch (err) {
      if (abort.signal.aborted) {
        patchLast((m) => ({ status: 'stopped', content: m.content }));
      } else {
        const message = err instanceof ChatError ? err.message : 'Something went wrong. Try again.';
        patchLast(() => ({ status: 'error', content: message }));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, []);

  const onSend = (text: string) => void send(text, messages);

  const onStop = () => abortRef.current?.abort();

  // Drop the failed reply and its question, then ask again.
  const onRetry = () => {
    const userMsg = messages.at(-2);
    if (!userMsg || userMsg.role !== 'user' || streaming) return;
    void send(userMsg.content, messages.slice(0, -2));
  };

  return (
    <div className="app">
      <Header thinking={streaming} />
      <MessageList messages={messages} onRetry={onRetry} />
      <Composer streaming={streaming} onSend={onSend} onStop={onStop} />
    </div>
  );
}
