export function Header({ thinking }: { thinking: boolean }) {
  return (
    <header className="header">
      <div
        className={`portrait${thinking ? ' portrait--thinking' : ''}`}
        role="img"
        aria-label={thinking ? 'IpsenGPT is thinking' : 'IpsenGPT'}
        data-testid="header-portrait"
      />
      <h1 className="header__title">IpsenGPT</h1>
    </header>
  );
}
