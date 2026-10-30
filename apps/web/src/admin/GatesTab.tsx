import { useState, type FormEvent } from 'react';
import {
  adminApi,
  ago,
  GATE_STATUS_LABELS,
  triggerLabel,
  type AdminGate,
  type AdminSession,
  type GateDefinition,
  type GateKind,
} from './api';
import { GateEditor } from './GateEditor';
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
  const [kind, setKind] = useState<GateKind>('photo');
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
    if (everyone && !window.confirm('Force this gate on everyone? Their chat stops until they pass it.')) return;
    setBusy(true);
    try {
      const deadlineMinutes = Number(minutes) > 0 ? Number(minutes) : undefined;
      const r = await adminApi.forceGate({
        ...(everyone ? { all: true } : { sessionId: who }),
        ...(custom ? { custom: { kind, target: target.trim(), guestPrompt: guestPrompt.trim() } } : { key }),
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
            {d.kind === 'text' ? '✍️ ' : ''}
            {d.target}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <>
          <select className="admin-input" aria-label="Custom gate kind" value={kind} onChange={(e) => setKind(e.target.value as GateKind)}>
            <option value="photo">Photo</option>
            <option value="text">Text (the AI judges their message)</option>
          </select>
          <input
            className="admin-input"
            placeholder={kind === 'photo' ? 'What must be in the photo, e.g. a broomstick' : 'What their message must do, e.g. a compliment for SadGPT'}
            aria-label="Custom gate target"
            maxLength={300}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <textarea
            className="admin-input admin-textarea admin-textarea--short"
            placeholder="What SadGPT says, e.g. Show me a broomstick. It's the only thing that could cheer me up."
            aria-label="What SadGPT demands"
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

/** A gate definition in the list, with its actions. */
function DefinitionCard({
  d,
  onEdit,
  onChanged,
  toast,
}: {
  d: GateDefinition;
  onEdit: () => void;
  onChanged: () => void;
  toast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="gate-definition">
      <div className="card__row">
        <strong>
          {d.kind === 'text' ? '✍️ ' : '📷 '}
          {d.target}
        </strong>
        <span className="admin-muted">{d.points} pts</span>
      </div>
      <div className="admin-muted">
        {d.kind === 'text' ? 'Text' : 'Photo'} · {d.person ? `${d.person.name} only` : 'everyone'} · {triggerLabel(d.trigger)}
        {d.shipped === 'changed' ? ' · edited' : ''}
      </div>
      <div className="force-gate__prompt">“{d.guestPrompt}”</div>
      <div className="card__actions">
        <button className="btn btn--small" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        {d.shipped === 'changed' && (
          <button
            className="btn btn--small"
            disabled={busy}
            onClick={() => window.confirm(`Undo your edits to "${d.id}"?`) && void run(() => adminApi.restoreGateDef(d.id), 'Gate reset')}
          >
            Reset to shipped
          </button>
        )}
        <button
          className="btn btn--small btn--danger"
          disabled={busy}
          onClick={() =>
            window.confirm(`Delete the gate "${d.id}"? Guests facing it now keep it.`) &&
            void run(() => adminApi.deleteGateDef(d.key), 'Gate deleted')
          }
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export function GatesTab({ toast }: Props) {
  const { data, reload, error } = usePoll(adminApi.gates, 5000);
  const { data: sessions } = usePoll(adminApi.sessions, 10000);
  const { data: people } = usePoll(adminApi.people, 30000);
  /** The definition being edited (its key), 'new', or null. */
  const [editing, setEditing] = useState<string | null>(null);

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
  const saved = () => {
    setEditing(null);
    void reload();
  };
  const restore = async (id: string) => {
    try {
      await adminApi.restoreGateDef(id);
      toast('Gate added back');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    }
  };
  const editor = (gate: GateDefinition | null) => (
    <GateEditor gate={gate} people={people?.people ?? []} toast={toast} onSaved={saved} onCancel={() => setEditing(null)} />
  );

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

      <h3 className="admin-h3">Gates ({data.definitions.length})</h3>
      {data.errors.length > 0 && (
        <div className="card" role="alert">
          {data.errors.map((e) => (
            <div key={e} className="admin-error">
              {e}
            </div>
          ))}
        </div>
      )}
      {editing === 'new' ? (
        editor(null)
      ) : (
        <button className="btn btn--primary gates__new" onClick={() => setEditing('new')}>
          New gate
        </button>
      )}
      <ul className="admin-list">
        {data.definitions.map((d) => (
          <li key={d.key}>
            {editing === d.key ? (
              editor(d)
            ) : (
              <DefinitionCard d={d} onEdit={() => setEditing(d.key)} onChanged={() => void reload()} toast={toast} />
            )}
          </li>
        ))}
      </ul>
      {data.missingShipped.length > 0 && (
        <>
          <h3 className="admin-h3">Deleted shipped gates</h3>
          <ul className="admin-list">
            {data.missingShipped.map((d) => (
              <li key={d.id} className="card card__row">
                <span>
                  {d.kind === 'text' ? '✍️ ' : '📷 '}
                  {d.target}
                </span>
                <button className="btn btn--small" onClick={() => void restore(d.id)}>
                  Add back
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
