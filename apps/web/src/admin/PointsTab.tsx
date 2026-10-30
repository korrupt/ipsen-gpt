import { useEffect, useState, type FormEvent } from 'react';
import { adminApi, ago, type AdminReward, type AdminSession } from './api';
import { usePoll } from './usePoll';

type Toast = (msg: string) => void;

/**
 * Give (or take, with a negative number) points with a reason the guest sees.
 * With `sessionId` it's for that guest; otherwise pick one.
 */
export function AwardForm({ sessionId, toast, onDone }: { sessionId?: string; toast: Toast; onDone: () => void }) {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [who, setWho] = useState(sessionId ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) void adminApi.sessions().then((s) => setSessions(s.filter((x) => x.name !== null)), () => {});
  }, [sessionId]);

  const n = Number(amount);
  const valid = who !== '' && Number.isInteger(n) && n !== 0 && reason.trim() !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const r = await adminApi.award(who, n, reason.trim());
      toast(`${n > 0 ? 'Gave' : 'Took'} ${Math.abs(n)} points (now ${r.total})`);
      setAmount('');
      setReason('');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const prefix = sessionId ?? 'any';
  return (
    <form className="card" onSubmit={(e) => void submit(e)} data-testid="award-form">
      {!sessionId && (
        <>
          <label className="admin-label" htmlFor={`award-who-${prefix}`}>
            Guest
          </label>
          <select id={`award-who-${prefix}`} className="admin-input" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.points} pts)
              </option>
            ))}
          </select>
        </>
      )}
      <label className="admin-label" htmlFor={`award-amount-${prefix}`}>
        Points (negative to take)
      </label>
      <input
        id={`award-amount-${prefix}`}
        className="admin-input"
        inputMode="numeric"
        placeholder="e.g. 10 or -5"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="admin-label" htmlFor={`award-reason-${prefix}`}>
        Reason (the guest sees it)
      </label>
      <input
        id={`award-reason-${prefix}`}
        className="admin-input"
        maxLength={200}
        placeholder="e.g. Saddest costume"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="card__actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !valid}>
          {n < 0 ? 'Take points' : 'Give points'}
        </button>
      </div>
    </form>
  );
}

function NewRewardForm({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [threshold, setThreshold] = useState('');
  const [prize, setPrize] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(threshold);
  const valid = Number.isInteger(n) && n > 0 && prize.trim() !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const r = await adminApi.addReward(n, prize.trim(), false);
      toast(r.winnerName ? `Added, and already won by ${r.winnerName}` : 'Reward added (prize hidden)');
      setThreshold('');
      setPrize('');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)} data-testid="reward-form">
      <label className="admin-label" htmlFor="reward-threshold">
        New reward: first to … points
      </label>
      <input
        id="reward-threshold"
        className="admin-input"
        inputMode="numeric"
        placeholder="e.g. 50"
        value={threshold}
        onChange={(e) => setThreshold(e.target.value)}
      />
      <label className="admin-label" htmlFor="reward-prize">
        Prize (hidden from guests until you show it)
      </label>
      <input
        id="reward-prize"
        className="admin-input"
        maxLength={200}
        placeholder="e.g. A bag of sad candy"
        value={prize}
        onChange={(e) => setPrize(e.target.value)}
      />
      <div className="card__actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !valid}>
          Add reward
        </button>
      </div>
    </form>
  );
}

function RewardCard({ reward, toast, onChange }: { reward: AdminReward; toast: Toast; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="reward">
      <div className="card__row">
        <strong>First to {reward.threshold} points</strong>
        <span className={`badge ${reward.winnerName ? 'badge--claimed' : 'badge--guest'}`}>
          {reward.winnerName ? `Won by ${reward.winnerName}` : 'Open'}
        </span>
      </div>
      <div>{reward.prize}</div>
      <div className="admin-muted">
        Guests see: {reward.revealed ? reward.prize : '???'}
        {reward.wonAt !== null && ` · won ${ago(reward.wonAt)}`}
      </div>
      <div className="card__actions">
        <button
          className={`btn${reward.revealed ? '' : ' btn--primary'}`}
          disabled={busy}
          onClick={() =>
            void run(
              () => adminApi.updateReward(reward.id, { revealed: !reward.revealed }),
              reward.revealed ? 'Prize hidden' : 'Prize shown to guests',
            )
          }
        >
          {reward.revealed ? 'Hide prize' : 'Show prize'}
        </button>
        <button
          className="btn btn--danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete "First to ${reward.threshold} points"?`)) {
              void run(() => adminApi.deleteReward(reward.id), 'Reward deleted');
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export function PointsTab({ toast }: { toast: Toast }) {
  const { data, reload, error } = usePoll(adminApi.points, 5000);
  const refresh = () => void reload();

  return (
    <section className="admin-tab">
      <h3 className="admin-h3">Give or take points</h3>
      <AwardForm toast={toast} onDone={refresh} />

      <h3 className="admin-h3">Rewards</h3>
      <NewRewardForm toast={toast} onDone={refresh} />
      {data?.rewards.length === 0 && <p className="admin-muted">No rewards yet.</p>}
      <ul className="admin-list">
        {data?.rewards.map((r) => (
          <li key={r.id}>
            <RewardCard reward={r} toast={toast} onChange={refresh} />
          </li>
        ))}
      </ul>

      <h3 className="admin-h3">Leaderboard</h3>
      {!data && <p className="admin-muted">{error ?? 'Loading…'}</p>}
      {data?.leaderboard.length === 0 && <p className="admin-muted">Nobody has points yet.</p>}
      <ol className="admin-list" data-testid="admin-leaderboard">
        {data?.leaderboard.map((s) => (
          <li key={s.sessionId} className="card card__row">
            <span>
              {s.rank}. {s.name}
            </span>
            <strong>{s.points}</strong>
          </li>
        ))}
      </ol>

      <h3 className="admin-h3">Recent</h3>
      {data?.recent.length === 0 && <p className="admin-muted">Nothing yet.</p>}
      <ul className="admin-list">
        {data?.recent.map((r) => (
          <li key={r.id} className="card">
            <div className="card__row">
              <strong>
                {r.amount > 0 ? '+' : ''}
                {r.amount} {r.sessionName ?? '(no name)'}
              </strong>
              <span className="admin-muted">{ago(r.createdAt)}</span>
            </div>
            <div className="admin-muted">
              {r.source === 'gate' ? 'Photo gate' : 'You'}: {r.reason}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
