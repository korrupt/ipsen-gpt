import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatClosedBanner } from './components/ChatClosedBanner';
import { ClaimBanner } from './components/ClaimBanner';
import { Composer } from './components/Composer';
import { GatePanel } from './components/GatePanel';
import { Header } from './components/Header';
import { LeaderboardSheet } from './components/LeaderboardSheet';
import { Toast } from './components/Toast';
import { MessageList, type Message } from './components/MessageList';
import { NamePicker } from './components/NamePicker';
import { useVisualViewport } from './hooks/useVisualViewport';
import { sendChat } from './lib/chatApi';
import { connectEvents, OPEN, rewardGoal, type ChatStatus, type Scoreboard, type Standing } from './lib/events';
import type { GateView, VerifyResult } from './lib/photos';
import {
  ApiError,
  chooseName,
  createSession,
  fetchLeaderboard,
  fetchSession,
  getToken,
  SessionGoneError,
  type HistoryItem,
  type SessionView,
} from './lib/session';

export const SESSION_ENDED_NOTICE = 'Your session has ended. Pick a name to start again.';
export const CLAIM_POLL_MS = 5000;

let nextId = 0;
const newId = () => `m${++nextId}`;
const fromHistory = (items: HistoryItem[]): Message[] =>
  items.map((m) => ({ id: newId(), role: m.role, content: m.content, status: 'done' }));

type Screen =
  | { kind: 'loading' }
  | { kind: 'offline' }
  /** `existing`: the session exists but has no name (claim rejected / name released). */
  | { kind: 'name'; notice: string | null; existing: boolean }
  | { kind: 'chat' };

export function App() {
  useVisualViewport();
  const [screen, setScreen] = useState<Screen>(() => (getToken() ? { kind: 'loading' } : { kind: 'name', notice: null, existing: false }));
  const [session, setSession] = useState<SessionView | null>(null);
  /** The photo gate blocking the chat, if any. */
  const [gate, setGate] = useState<GateView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** Whether chat is open (the PC is reachable and the host hasn't paused it); pushed live. */
  const [chatStatus, setChatStatus] = useState<ChatStatus>(OPEN);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [showScores, setShowScores] = useState(false);
  /** A short notice: points from the host, a reward won. */
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const abortRef = useRef<AbortController | null>(null);

  /** Applies a fresh session view from the server and picks the right screen. */
  const applySession = useCallback((s: SessionView) => {
    setSession(s);
    setScreen(s.name === null ? { kind: 'name', notice: s.notice, existing: true } : { kind: 'chat' });
  }, []);

  const sessionGone = useCallback(() => {
    setSession(null);
    setGate(null);
    setMessages([]);
    setScreen({ kind: 'name', notice: SESSION_ENDED_NOTICE, existing: false });
  }, []);

  const load = useCallback(async () => {
    try {
      const { session: s, messages: history, gate: g } = await fetchSession();
      setMessages(fromHistory(history));
      setGate(g ?? null);
      applySession(s);
    } catch (err) {
      if (err instanceof SessionGoneError) setScreen({ kind: 'name', notice: null, existing: false });
      else setScreen({ kind: 'offline' });
    }
  }, [applySession]);

  useEffect(() => {
    if (getToken()) void load();
  }, [load]);

  // Live updates while chatting: gates the moment they start, and whether chat is open.
  const inChat = screen.kind === 'chat';
  useEffect(() => {
    if (!inChat) return;
    return connectEvents({
      onStatus: setChatStatus,
      onGate: setGate,
      onSessionGone: sessionGone,
      onStanding: setStanding,
      onScoreboard: setBoard,
      onPointsAwarded: ({ amount, reason }) => setToast(`${amount > 0 ? '+' : ''}${amount} points: ${reason}`),
      onRewardWon: (r) => setToast(`You won! ${rewardGoal(r)}${r.prize ? `: ${r.prize}` : '. Find SadGPT\'s human for your prize.'}`),
    });
  }, [inChat, sessionGone]);

  const openScores = useCallback(() => {
    setShowScores(true);
    // The live stream normally keeps these fresh; this covers a stream that's down.
    fetchLeaderboard()
      .then(({ me, ...rest }) => {
        setBoard(rest);
        setStanding(me);
      })
      .catch(() => {});
  }, []);

  // While a claim is pending, check for approval/rejection. (Phase 6 moves this onto the live events.)
  useEffect(() => {
    if (session?.state !== 'pending_claim') return;
    const timer = setInterval(async () => {
      try {
        const r = await fetchSession();
        setGate(r.gate ?? null);
        applySession(r.session);
      } catch (err) {
        if (err instanceof SessionGoneError) sessionGone();
      }
    }, CLAIM_POLL_MS);
    return () => clearInterval(timer);
  }, [session?.state, applySession, sessionGone]);

  const pickName = async (name: string): Promise<string | null> => {
    try {
      if (screen.kind === 'name' && screen.existing) {
        applySession(await chooseName(name));
      } else {
        const created = await createSession(name);
        setGate(created.gate);
        applySession(created.session);
      }
      return null;
    } catch (err) {
      if (err instanceof SessionGoneError) {
        setScreen({ kind: 'name', notice: null, existing: false });
        return 'Your old session ended. Try again.';
      }
      return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
    }
  };

  const patchLast = (patch: (m: Message) => Partial<Message>) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      return last ? [...ms.slice(0, -1), { ...last, ...patch(last) }] : ms;
    });

  const send = useCallback(
    async (text: string, prior: Message[]) => {
      setMessages([
        ...prior,
        { id: newId(), role: 'user', content: text, status: 'done' },
        { id: newId(), role: 'assistant', content: '', status: 'streaming' },
      ]);
      setStreaming(true);
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        await sendChat(text, (t) => patchLast((m) => ({ content: m.content + t })), abort.signal, setGate);
        patchLast(() => ({ status: 'done' }));
      } catch (err) {
        if (abort.signal.aborted) {
          patchLast(() => ({ status: 'stopped' }));
        } else if (err instanceof SessionGoneError) {
          sessionGone();
        } else if (err instanceof ApiError && err.code === 'name_required') {
          void load();
        } else if (err instanceof ApiError && err.code === 'chat_closed') {
          // Closed before the live update got here. Take the message back; it was never sent.
          setMessages(prior);
          setChatStatus({ open: false, reason: null, message: err.message });
        } else {
          const message = err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
          patchLast(() => ({ status: 'error', content: message }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [load, sessionGone],
  );

  const onSend = (text: string) => void send(text, messages);

  const onGateResult = (r: VerifyResult) => {
    setGate(r.gate);
    if (r.kind === 'verdict' && r.result === 'passed') {
      setMessages((ms) => [...ms, { id: newId(), role: 'assistant', content: r.message, status: 'done' }]);
    }
  };

  // A deadline passed: the server knows whether another gate is waiting.
  const onGateExpired = useCallback(async () => {
    try {
      setGate((await fetchSession()).gate ?? null);
    } catch (err) {
      if (err instanceof SessionGoneError) sessionGone();
      else setGate(null);
    }
  }, [sessionGone]);
  const onStop = () => abortRef.current?.abort();

  // Drop the failed reply and its question, then ask again.
  const onRetry = () => {
    const userMsg = messages.at(-2);
    if (!userMsg || userMsg.role !== 'user' || streaming) return;
    void send(userMsg.content, messages.slice(0, -2));
  };

  return (
    <div className="app">
      <Header
        thinking={streaming}
        name={screen.kind === 'chat' ? session?.name : null}
        points={screen.kind === 'chat' ? (standing?.points ?? null) : null}
        onScores={openScores}
      />
      {toast && <Toast message={toast} onDone={clearToast} />}
      {showScores && screen.kind === 'chat' && (
        <LeaderboardSheet board={board} standing={standing} name={session?.name ?? null} onClose={() => setShowScores(false)} />
      )}
      {screen.kind === 'loading' && <main className="messages" aria-busy="true" />}
      {screen.kind === 'offline' && (
        <main className="messages">
          <div className="empty">
            <p>SadGPT could not reach the server. Typical.</p>
            <button type="button" className="link-button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </main>
      )}
      {screen.kind === 'name' && <NamePicker notice={screen.notice} onSubmit={pickName} />}
      {screen.kind === 'chat' && (
        <>
          {session?.state === 'pending_claim' && session.claimCode && <ClaimBanner code={session.claimCode} />}
          <MessageList messages={messages} onRetry={onRetry} />
          {gate && <GatePanel gate={gate} onResult={onGateResult} onSessionGone={sessionGone} onExpired={onGateExpired} />}
          {!chatStatus.open && chatStatus.message && <ChatClosedBanner message={chatStatus.message} />}
          <Composer streaming={streaming} disabled={!chatStatus.open} onSend={onSend} onStop={onStop} />
        </>
      )}
    </div>
  );
}
