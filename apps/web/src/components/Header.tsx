export function Header({ thinking, name }: { thinking: boolean; name?: string | null }) {
  return (
    <header className="header">
      <div
        className={`portrait${thinking ? ' portrait--thinking' : ''}`}
        role="img"
        aria-label={thinking ? 'IpsenGPT is thinking' : 'IpsenGPT'}
        data-testid="header-portrait"
      />
      <h1 className="header__title">IpsenGPT</h1>
      {name && (
        <span className="header__user" title={`Chatting as ${name}`} data-testid="header-user">
          {name}
        </span>
      )}
    </header>
  );
}
