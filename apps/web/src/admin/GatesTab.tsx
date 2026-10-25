import { useState, type FormEvent } from 'react';
import {
  adminApi,
  ago,
  GATE_STATUS_LABELS,
  triggerLabel,
  type AdminGate,
  type AdminSession,
  type GateDefinition,
} from './api';
import { usePoll } from './usePoll';

interface Props {
  toast: (msg: string) => void;
}

const CUSTOM = '__custom__';
const EVERYONE = '__everyone__';

/** "in 4 min", "in 35 s". */
function untilLabel(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  return s < 90 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

/**
 * Hands out a gate: one from gates.json or a custom one typed in here. With
 * `sessionId` it targets that session; otherwise the admin picks someone or everyone.
 */
export function ForceGateForm({
  definitions,
  sessions,
  sessionId,
  toast,
  onDone,
}: {
  definitions: GateDefinition[];
  sessions?: AdminSession[];
  sessionId?: string;
  toast: (msg: string) => void;
  onDone: () => void;
}) {
  const [who, setWho] = useState(sessionId ?? '');
  const [key, setKey] = useState('');
  const [target, setTarget] = useState('');
  const [guestPrompt, setGuestPrompt] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);

  const custom = key === CUSTOM;
  const ready = !!who && !!key && (!custom || (target.trim() && guestPrompt.trim()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    const everyone = who === EVERYONE;
    if (everyone && !window.confirm('Force this gate on everyone? Their chat stops until they send a photo.')) return;
    setBusy(true);
    try {
      const deadlineMinutes = Number(minutes) > 0 ? Number(minutes) : undefined;
      const r = await adminApi.forceGate({
        ...(everyone ? { all: true } : { sessionId: who }),
        ...(custom ? { custom: { target: target.trim(), guestPrompt: guestPrompt.trim() } } : { key }),
        deadlineMinutes,
      });
      toast(r.count === 1 ? 'Gate forced' : `Gate forced on ${r.count} guests`);
      setKey('');
      setTarget('');
      setGuestPrompt('');
      setMinutes('');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card force-gate" onSubmit={submit} aria-label="Force a gate">
      {!sessionId && (
        <>
          <label className="admin-label" htmlFor="force-who">
            Who
          </label>
          <select id="force-who" className="admin-input" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose…</option>
            <option value={EVERYONE}>Everyone</option>
            {(sessions ?? [])
              .filter((s) => s.name !== null)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </>
      )}
      <label className="admin-label" htmlFor={`force-gate-${sessionId ?? 'any'}`}>
        Gate
      </label>
      <select
        id={`force-gate-${sessionId ?? 'any'}`}
        className="admin-input"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      >
        <option value="">Choose…</option>
        {definitions.map((d) => (
          <option key={d.key} value={d.key}>
            {d.person ? `${d.person.name}: ` : ''}
            {d.target}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <>
          <input
            className="admin-input"
            placeholder="What must be in the photo, e.g. a broomstick"
            aria-label="Custom gate target"
            maxLength={200}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <textarea
            className="admin-input admin-textarea"
            placeholder="What IpsenGPT says, e.g. Show me a broomstick or be silent forever."
            aria-label="What IpsenGPT demands"
            maxLength={1000}
            rows={2}
            value={guestPrompt}
            onChange={(e) => setGuestPrompt(e.target.value)}
          />
        </>
      )}
      <div className="card__actions">
        <input
          className="admin-input force-gate__minutes"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="No deadline"
          aria-label="Deadline in minutes"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
          Force gate
        </button>
      </div>
    </form>
  );
}

export function GateCard({ gate, onCancel, showName = true }: { gate: AdminGate; onCancel?: () => void; showName?: boolean }) {
  return (
    <div className="card" data-testid="gate-card">
      <div className="card__row">
        <strong>{showName ? (gate.sessionName ?? <em>no name</em>) : gate.target}</strong>
        <span className={`badge badge--gate-${gate.status}`}>{GATE_STATUS_LABELS[gate.status]}</span>
      </div>
      {showName && <div>{gate.target}</div>}
      <div className="admin-muted">
        {gate.source.replace('_', ' ')} · {ago(gate.createdAt)}
        {gate.status === 'active' && gate.deadlineAt ? ` · expires ${untilLabel(gate.deadlineAt)}` : ''}
        {gate.refusals > 0 ? ` · refused ${gate.refusals}×` : ''}
      </div>
      {onCancel && gate.status === 'active' && (
        <div className="card__actions">
          <button className="btn btn--small" onClick={onCancel}>
            Cancel gate
          </button>
        </div>
      )}
    </div>
  );
}

export function GatesTab({ toast }: Props) {
  const { data, reload, error } = usePoll(adminApi.gates, 5000);
  const { data: sessions } = usePoll(adminApi.sessions, 10000);

  if (!data) return <p className="admin-muted admin-tab">{error ?? 'Loading…'}</p>;

  const cancel = async (g: AdminGate) => {
    try {
      await adminApi.cancelGate(g.id);
      toast('Gate cancelled');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <section className="admin-tab">
      <h3 className="admin-h3">Force a gate</h3>
      <ForceGateForm definitions={data.definitions} sessions={sessions ?? []} toast={toast} onDone={() => void reload()} />

      <h3 className="admin-h3">Active ({data.active.length})</h3>
      {data.active.length === 0 && <p className="admin-muted">Nobody is blocked.</p>}
      <ul className="admin-list">
        {data.active.map((g) => (
          <li key={g.id}>
            <GateCard gate={g} onCancel={() => void cancel(g)} />
          </li>
        ))}
      </ul>

      <h3 className="admin-h3">Defined in gates.json ({data.definitions.length})</h3>
      {data.errors.length > 0 && (
        <div className="card" role="alert">
          {data.errors.map((e) => (
            <div key={e} className="admin-error">
              {e}
            </div>
          ))}
        </div>
      )}
      <ul className="admin-list">
        {data.definitions.map((d) => (
          <li key={d.key} className="card">
            <div className="card__row">
              <strong>{d.target}</strong>
              <span className="admin-muted">{d.points} pts</span>
            </div>
            <div className="admin-muted">
              {d.person ? `${d.person.name} only · ` : ''}
              {triggerLabel(d.trigger)}
            </div>
            <div className="force-gate__prompt">“{d.guestPrompt}”</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
