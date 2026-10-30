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

  /** `slug`: who to approve them as, when the claim matches several people. */
  const act = async (c: AdminSession, action: 'approve' | 'reject', slug?: string) => {
    setBusyId(c.id);
    try {
      if (action === 'approve') {
        const s = await adminApi.approve(c.id, slug);
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
              {c.claimPeople.length > 1 ? 'Wants to be one of ' : 'Wants to be '}
              {c.claimPeople.length === 0 ? <strong>?</strong> : c.claimPeople.map((p, i) => (
                <span key={p.slug}>
                  {i > 0 && (i === c.claimPeople.length - 1 ? ' or ' : ', ')}
                  <strong>{p.name}</strong>
                </span>
              ))}
            </div>
            <div className="admin-muted">
              Typed “{c.name}” · {ago(c.createdAt)}
            </div>
            <div className="card__actions">
              {c.claimPeople.length > 1 ? (
                c.claimPeople.map((p) => (
                  <button
                    key={p.slug}
                    className="btn btn--approve"
                    disabled={busyId === c.id}
                    onClick={() => void act(c, 'approve', p.slug)}
                  >
                    Approve as {p.name}
                  </button>
                ))
              ) : (
                <button className="btn btn--approve" disabled={busyId === c.id} onClick={() => void act(c, 'approve')}>
                  Approve
                </button>
              )}
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
