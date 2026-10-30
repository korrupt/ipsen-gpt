import { useEffect, useState, type FormEvent } from 'react';
import { adminApi, ago, type SecretPlayer, type SecretsOverview } from './api';
import { usePoll } from './usePoll';

type Toast = (msg: string) => void;

function SwitchCard({ data, toast, onChange }: { data: SecretsOverview; toast: Toast; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    if (data.enabled && !window.confirm('Stop the secrets game? SadGPT forgets its secret; levels and points are kept.')) return;
    setBusy(true);
    try {
      await adminApi.updateSecrets({ enabled: !data.enabled });
      toast(data.enabled ? 'Secrets game stopped' : 'Secrets game started');
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="secrets-switch">
      <div className="card__row">
        <strong>{data.enabled ? 'The secrets game is on' : 'The secrets game is off'}</strong>
      </div>
      <div className="admin-muted">
        {data.enabled
          ? 'SadGPT guards a secret word in every chat, and guests see the 🔑 button.'
          : 'SadGPT has no secret and guests see nothing. Start it when you announce it.'}
      </div>
      <div className="card__actions">
        <button className={`btn ${data.enabled ? 'btn--danger' : 'btn--primary'}`} disabled={busy} onClick={() => void flip()}>
          {data.enabled ? 'Stop the game' : 'Start the game'}
        </button>
      </div>
    </div>
  );
}

function PointsCard({ data, toast, onChange }: { data: SecretsOverview; toast: Toast; onChange: () => void }) {
  const [values, setValues] = useState(() => data.points.map(String));
  const [busy, setBusy] = useState(false);
  const saved = data.points.join(',');
  // Follow saved changes (e.g. from another tab) unless mid-edit.
  useEffect(() => setValues(saved.split(',')), [saved]);

  const numbers = values.map(Number);
  const valid = values.every((v) => v.trim() !== '') && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 10_000);
  const changed = numbers.join(',') !== saved;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !changed) return;
    setBusy(true);
    try {
      await adminApi.updateSecrets({ points: numbers });
      toast('Points saved');
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)} data-testid="secrets-points">
      <div className="admin-muted">Points for finding each level's secret. Changes count from the next right guess.</div>
      <div className="secrets-points">
        {values.map((v, i) => (
          <label key={i} className="secrets-points__level">
            <span className="admin-label">Level {i + 1}</span>
            <input
              className="admin-input"
              inputMode="numeric"
              value={v}
              onChange={(e) => setValues((vs) => vs.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
      </div>
      <div className="card__actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !valid || !changed}>
          Save points
        </button>
      </div>
    </form>
  );
}

function PlayerCard({ p, levels }: { p: SecretPlayer; levels: number }) {
  const done = p.level > levels;
  return (
    <div className="card" data-testid="secret-player">
      <div className="card__row">
        <strong>{p.name ?? '(no name)'}</strong>
        <span className="admin-muted">{done ? 'All found' : `Level ${p.level} of ${levels}`}</span>
      </div>
      {!done && (
        <div>
          Now after: <code className="secrets-word">{p.word ? p.word.toUpperCase() : 'not picked yet'}</code>
        </div>
      )}
      {p.solved.length > 0 && (
        <div className="admin-muted">
          Found: {p.solved.map((s) => s.word.toUpperCase()).join(', ')}
          {p.lastSolvedAt ? ` (last ${ago(p.lastSolvedAt)})` : ''}
        </div>
      )}
    </div>
  );
}

/** The secrets game: on/off, points per level, and every player's level and current word. */
export function SecretsTab({ toast }: { toast: Toast }) {
  const { data, reload, error } = usePoll(adminApi.secrets, 5000);
  const refresh = () => void reload();

  if (!data) {
    return (
      <section className="admin-tab">
        <p className="admin-muted">{error ?? 'Loading…'}</p>
      </section>
    );
  }
  return (
    <section className="admin-tab">
      <h3 className="admin-h3">Secrets game</h3>
      <SwitchCard data={data} toast={toast} onChange={refresh} />
      <PointsCard data={data} toast={toast} onChange={refresh} />

      <h3 className="admin-h3">Players</h3>
      <p className="admin-muted">
        Furthest first. A word is picked when a guest first chats at that level. A level can start with a photo gate
        (trigger secret_level in gates.json).
      </p>
      {data.players.length === 0 && <p className="admin-muted">Nobody has played yet.</p>}
      <ul className="admin-list">
        {data.players.map((p) => (
          <li key={p.sessionId}>
            <PlayerCard p={p} levels={data.levels} />
          </li>
        ))}
      </ul>
    </section>
  );
}
