import { useEffect, useRef } from 'react';
import { rewardGoal, type Scoreboard, type Standing } from '../lib/events';

interface Props {
  board: Scoreboard | null;
  standing: Standing | null;
  /** The guest's own name, to highlight their row. */
  name: string | null;
  onClose: () => void;
}

/** The leaderboard and the rewards, over the chat. Hidden prizes show as "???". */
export function LeaderboardSheet({ board, standing, name, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const top = board?.top ?? [];
  const inTop = top.some((s) => s.name === name);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet__head">
          <h2 id="sheet-title">Leaderboard</h2>
          <button ref={closeRef} type="button" className="sheet__close" aria-label="Close the leaderboard" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        {!board && <p className="sheet__muted">Loading…</p>}
        {board && top.length === 0 && <p className="sheet__muted">Nobody has any points yet. Sad, really.</p>}
        {top.length > 0 && (
          <ol className="board" data-testid="leaderboard">
            {top.map((s) => (
              <li key={s.rank} className={`board__row${s.name === name ? ' board__row--me' : ''}`}>
                <span className="board__rank">{s.rank}</span>
                <span className="board__name">{s.name}</span>
                <span className="board__points">{s.points}</span>
              </li>
            ))}
          </ol>
        )}
        {board && standing && !inTop && (
          <p className="sheet__me" data-testid="my-standing">
            You: {standing.points} points{standing.rank ? `, place ${standing.rank}` : ''}
          </p>
        )}

        {board && board.rewards.length > 0 && (
          <>
            <h3 className="sheet__h3">Rewards</h3>
            <ul className="rewards" data-testid="rewards">
              {board.rewards.map((r) => (
                <li key={r.id} className="rewards__row">
                  <span className="rewards__goal">{rewardGoal(r)}</span>
                  <span className="rewards__prize">{r.prize ?? '???'}</span>
                  <span className="rewards__winner">{r.winner ? `Won by ${r.winner}` : 'Up for grabs'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
