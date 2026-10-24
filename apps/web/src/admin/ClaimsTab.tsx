import { useState } from 'react';
import { adminApi, ago, normalizeCode, type AdminSession } from './api';

interface Props {
  claims: AdminSession[] | null;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
}

export function ClaimsTab({ claims, reload, toast }: Props) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = normalizeCode(query);
  const shown = (claims ?? []).filter((c) => !q || normalizeCode(c.claimCode ?? '').includes(q));

  const act = async (c: AdminSession, action: 'approve' | 'reject') => {
    setBusyId(c.id);
    try {
      if (action === 'approve') {
        const s = await adminApi.approve(c.id);
        toast(`Approved: ${s.name}`);
      } else {
        await adminApi.reject(c.id);
        toast(`Rejected ${c.claimCode}`);
      }
      setQuery('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="admin-tab">
      <input
        className="admin-input admin-input--code"
        placeholder="Search code, e.g. BAT 427"
        aria-label="Search claim code"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {claims === null && <p className="admin-muted">Loading…</p>}
      {claims !== null && shown.length === 0 && (
        <p className="admin-muted">{q ? 'No claim with that code.' : 'No pending claims.'}</p>
      )}
      <ul className="admin-list">
        {shown.map((c) => (
          <li key={c.id} className="card" data-testid="claim">
            <div className="claim-card__code">{c.claimCode}</div>
            <div>
              Wants to be <strong>{c.claimPerson?.name ?? '?'}</strong>
            </div>
            <div className="admin-muted">
              Typed “{c.name}” · {ago(c.createdAt)}
            </div>
            <div className="card__actions">
              <button className="btn btn--approve" disabled={busyId === c.id} onClick={() => void act(c, 'approve')}>
                Approve
              </button>
              <button className="btn btn--danger" disabled={busyId === c.id} onClick={() => void act(c, 'reject')}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
