import { useState, type FormEvent } from 'react';
import { adminApi, ago, type Personas, type SystemStatus } from './api';
import { PersonaEditor, PersonaList, RulesEditor, type PersonaEditing } from './PersonasEditor';
import { usePersonas } from './PersonaSelect';
import { usePoll } from './usePoll';

function ModelCard({ model }: { model: SystemStatus['model'] }) {
  const ok = model.reachable && model.hasModel;
  const state = !model.reachable ? 'Disconnected' : model.hasModel ? 'Connected' : 'Model not pulled';
  return (
    <div className="card" data-testid="model">
      <div className="card__row">
        <strong>Model (the PC)</strong>
        <span className={`badge ${ok ? 'badge--claimed' : 'badge--pending_claim'}`}>{state}</span>
      </div>
      <div>{model.model}</div>
      <div className="admin-muted">
        {model.url}
        {model.checkedAt !== null && ` · checked ${ago(model.checkedAt)}`}
      </div>
      {model.error && <div className="admin-error">{model.error}</div>}
    </div>
  );
}

/** Pause chat for everyone with a reason guests see, or resume it. */
function PauseCard({ pauseReason, onChange, toast }: { pauseReason: string | null; onChange: () => Promise<void>; toast: (msg: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast(done);
      await onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const pause = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) void run(() => adminApi.pause(reason.trim()), 'Chat paused');
  };

  if (pauseReason) {
    return (
      <div className="card" data-testid="pause">
        <div className="card__row">
          <strong>Chat is paused</strong>
          <span className="badge badge--pending_claim">Paused</span>
        </div>
        <div>Guests see: “{pauseReason}”</div>
        <div className="card__actions">
          <button className="btn" disabled={busy} onClick={() => void run(adminApi.resume, 'Chat resumed')}>
            Resume chat
          </button>
        </div>
      </div>
    );
  }
  return (
    <form className="card" data-testid="pause" onSubmit={pause}>
      <label className="admin-label" htmlFor="pause-reason">
        Pause chat for everyone
      </label>
      <input
        id="pause-reason"
        className="admin-input"
        placeholder="What guests see, e.g. Speeches! SadGPT is back in 10 minutes."
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="card__actions">
        <button className="btn btn--danger" type="submit" disabled={busy || !reason.trim()}>
          Pause chat
        </button>
      </div>
    </form>
  );
}

/** The persona everyone gets unless their session has its own. */
function GlobalPersonaCard({
  personas,
  reload,
  toast,
}: {
  personas: Personas | null;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!personas) return null;
  const active = personas.personas.find((p) => p.id === personas.activeId);

  const pick = async (id: string) => {
    setBusy(true);
    try {
      await adminApi.setActivePersona(id);
      await reload();
      toast(`Persona: ${personas.personas.find((p) => p.id === id)?.name ?? id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="global-persona">
      <label className="admin-label" htmlFor="global-persona">
        Persona for everyone (guests with their own, set in Sessions, keep theirs)
      </label>
      <select
        id="global-persona"
        className="admin-input"
        value={personas.activeId}
        disabled={busy}
        onChange={(e) => void pick(e.target.value)}
      >
        {personas.personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === personas.defaultId ? ' (default)' : ''}
          </option>
        ))}
      </select>
      {active?.description && <div className="admin-muted">{active.description}</div>}
      <div className="admin-muted">Takes effect on everyone's next message.</div>
      {personas.errors.map((e) => (
        <p key={e} className="admin-error">
          {e}
        </p>
      ))}
    </div>
  );
}

export function SystemTab({ toast }: { toast: (msg: string) => void }) {
  const { data, reload, error } = usePoll(adminApi.system, 10000);
  const [personas, reloadPersonas] = usePersonas();
  const [editing, setEditing] = useState<PersonaEditing | null>(null);

  if (editing) {
    const done = () => {
      setEditing(null);
      void reloadPersonas();
    };
    return editing.kind === 'rules' ? (
      <RulesEditor toast={toast} onDone={done} />
    ) : (
      <PersonaEditor id={editing.id} toast={toast} onDone={done} />
    );
  }

  if (!data) return <p className="admin-muted admin-tab">{error ?? 'Loading…'}</p>;
  const { model, status, pauseReason, listeners, errors } = data;

  return (
    <section className="admin-tab">
      <p className="admin-muted" data-testid="guest-view">
        {status.open ? 'Guests can chat.' : `Chat is closed. Guests see: “${status.message}”`} {listeners} page
        {listeners === 1 ? '' : 's'} open.
      </p>
      <ModelCard model={model} />
      <PauseCard pauseReason={pauseReason} onChange={reload} toast={toast} />
      <GlobalPersonaCard personas={personas} reload={reloadPersonas} toast={toast} />
      {personas && <PersonaList personas={personas} onEdit={setEditing} onChanged={reloadPersonas} toast={toast} />}
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
