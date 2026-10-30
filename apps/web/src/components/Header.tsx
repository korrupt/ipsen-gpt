interface Props {
  thinking: boolean;
  name?: string | null;
  /** The guest's points; the button opens the leaderboard. Hidden until known. */
  points?: number | null;
  onScores?: () => void;
}

export function Header({ thinking, name, points, onScores }: Props) {
  return (
    <header className="header">
      <div
        className={`portrait${thinking ? ' portrait--thinking' : ''}`}
        role="img"
        aria-label={thinking ? 'SadGPT is thinking' : 'SadGPT'}
        data-testid="header-portrait"
      />
      <h1 className="header__title">SadGPT</h1>
      {name && (
        <span className="header__user" title={`Chatting as ${name}`} data-testid="header-user">
          {name}
        </span>
      )}
      {points !== undefined && points !== null && onScores && (
        <button
          type="button"
          className="score-button"
          onClick={onScores}
          aria-label={`${points} points. Open the leaderboard`}
          data-testid="score-button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3" />
          </svg>
          {points}
        </button>
      )}
    </header>
  );
}
