import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, setUnauthorizedHandler } from './api';
import { ClaimsTab } from './ClaimsTab';
import { GatesTab } from './GatesTab';
import { Login } from './Login';
import { PeopleTab } from './PeopleTab';
import { PhotosTab } from './PhotosTab';
import { SessionsTab } from './SessionsTab';
import { SystemTab } from './SystemTab';
import { usePoll } from './usePoll';

type Tab = 'claims' | 'sessions' | 'gates' | 'photos' | 'people' | 'system';

export function AdminApp() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setLoggedIn(false));
    adminApi.me().then(
      () => setLoggedIn(true),
      () => setLoggedIn(false),
    );
  }, []);

  if (loggedIn === null) return <div className="admin" aria-busy="true" />;
  if (!loggedIn) {
    return (
      <div className="admin">
        <Login onLoggedIn={() => setLoggedIn(true)} />
      </div>
    );
  }
  return <Dashboard onLogout={() => setLoggedIn(false)} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('claims');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Claims are polled here so the tab badge stays live on every screen.
  const { data: claims, reload: reloadClaims } = usePoll(adminApi.claims, 4000);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2500);
  }, []);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'claims', label: 'Claims', badge: claims?.length },
    { id: 'sessions', label: 'Sessions' },
    { id: 'gates', label: 'Gates' },
    { id: 'photos', label: 'Photos' },
    { id: 'people', label: 'People' },
    { id: 'system', label: 'System' },
  ];

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="portrait" aria-hidden="true" />
        <h1>IpsenGPT admin</h1>
        <button className="btn btn--ghost btn--small" onClick={() => void adminApi.logout().finally(onLogout)}>
          Log out
        </button>
      </header>
      <main className="admin-main">
        {tab === 'claims' && <ClaimsTab claims={claims} reload={reloadClaims} toast={toast} />}
        {tab === 'sessions' && <SessionsTab toast={toast} />}
        {tab === 'gates' && <GatesTab toast={toast} />}
        {tab === 'photos' && <PhotosTab toast={toast} />}
        {tab === 'people' && <PeopleTab toast={toast} />}
        {tab === 'system' && <SystemTab toast={toast} />}
      </main>
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
      <nav className="admin-nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`admin-nav__tab${tab === t.id ? ' admin-nav__tab--active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {!!t.badge && <span className="admin-nav__badge">{t.badge}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
