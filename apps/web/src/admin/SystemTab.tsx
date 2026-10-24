import { useState } from 'react';
import { adminApi, ago, type ProbeResult } from './api';
import { usePoll } from './usePoll';

function ModelCard({ title, probe, active }: { title: string; probe: ProbeResult; active: boolean }) {
  const ok = probe.reachable && probe.hasModel;
  const state = !probe.reachable ? 'Unreachable' : probe.hasModel ? 'Ready' : 'Model not pulled';
  return (
    <div className="card" data-testid={`model-${title.toLowerCase()}`}>
      <div className="card__row">
        <strong>{title}</strong>
        <span className={`badge ${ok ? 'badge--claimed' : 'badge--pending_claim'}`}>{state}</span>
      </div>
      <div>
        {probe.model}
        {active && <span className="admin-muted"> · answering now</span>}
      </div>
      <div className="admin-muted">{probe.url}</div>
      {probe.error && <div className="admin-error">{probe.error}</div>}
    </div>
  );
}

export function SystemTab({ toast }: { toast: (msg: string) => void }) {
  const { data, reload, error } = usePoll(adminApi.system, 10000);
  const [busy, setBusy] = useState(false);

  if (!data) return <p className="admin-muted admin-tab">{error ?? 'Loading…'}</p>;
  const { llm, errors } = data;
  // What the next guest message will use.
  const next = llm.forceFallback || llm.primarySkippedUntil ? 'fallback' : 'primary';

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await adminApi.setForceFallback(!llm.forceFallback);
      toast(r.forceFallback ? 'Forced fallback model' : 'Back to automatic');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-tab">
      <ModelCard title="Primary" probe={llm.primary} active={next === 'primary'} />
      {llm.fallback && <ModelCard title="Fallback" probe={llm.fallback} active={next === 'fallback'} />}
      {llm.primarySkippedUntil && !llm.forceFallback && (
        <p className="admin-muted">
          Primary failed recently; trying it again in {Math.max(0, Math.ceil((llm.primarySkippedUntil - Date.now()) / 1000))} s.
        </p>
      )}
      {llm.fallback && (
        <button className={`btn ${llm.forceFallback ? 'btn--danger' : ''}`} disabled={busy} onClick={() => void toggle()}>
          {llm.forceFallback ? 'Stop forcing fallback' : 'Force fallback model'}
        </button>
      )}
      <h3 className="admin-h3">Recent errors</h3>
      {errors.length === 0 && <p className="admin-muted">None.</p>}
      <ul className="admin-list">
        {errors.map((e, i) => (
          <li key={i} className="card">
            <div className="card__row">
              <strong>{e.message}</strong>
              <span className="admin-muted">{ago(e.at)}</span>
            </div>
            {e.detail && <div className="admin-muted admin-error-detail">{e.detail}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
