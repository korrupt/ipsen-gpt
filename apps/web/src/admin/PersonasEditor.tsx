import { useEffect, useState } from 'react';
import { adminApi, type Personas } from './api';

type Toast = (msg: string) => void;
export type PersonaEditing = { kind: 'persona'; id: string | null } | { kind: 'rules' };

/** The persona list on the System tab: open one to edit, add new or shipped ones, edit the shared rules. */
export function PersonaList({
  personas,
  onEdit,
  onChanged,
  toast,
}: {
  personas: Personas;
  onEdit: (e: PersonaEditing) => void;
  onChanged: () => Promise<void>;
  toast: Toast;
}) {
  const missing = personas.defaults.filter((d) => !d.inUse);
  const add = async (id: string, name: string) => {
    try {
      await adminApi.restorePersona(id);
      await onChanged();
      toast(`Added ${name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="card" data-testid="persona-list">
      <strong>Edit personas</strong>
      <ul className="admin-list">
        {personas.personas.map((p) => (
          <li key={p.id}>
            <button className="card card--button" onClick={() => onEdit({ kind: 'persona', id: p.id })}>
              <div className="card__row">
                <strong>{p.name}</strong>
                {p.id === personas.activeId && <span className="badge badge--claimed">Everyone</span>}
              </div>
              {p.description && <div className="admin-muted">{p.description}</div>}
            </button>
          </li>
        ))}
      </ul>
      <div className="card__actions">
        <button className="btn btn--primary" onClick={() => onEdit({ kind: 'persona', id: null })}>
          + New persona
        </button>
        <button className="btn" onClick={() => onEdit({ kind: 'rules' })}>
          Shared rules
        </button>
      </div>
      {missing.length > 0 && (
        <div className="admin-muted">
          Deleted defaults:{' '}
          {missing.map((d) => (
            <button key={d.id} className="btn btn--small" onClick={() => void add(d.id, d.name)}>
              + {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Edit one persona, or create one (`id: null`). */
export function PersonaEditor({ id, onDone, toast }: { id: string | null; onDone: () => void; toast: Toast }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [hasDefault, setHasDefault] = useState(false);
  const [loaded, setLoaded] = useState(id === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) return;
    adminApi.persona(id).then(
      (r) => {
        setName(r.persona.name);
        setDescription(r.persona.description);
        setBody(r.persona.body);
        setHasDefault(r.hasDefault);
        setLoaded(true);
      },
      (err: unknown) => {
        toast(err instanceof Error ? err.message : 'Failed');
        onDone();
      },
    );
    // Load once per persona; the callbacks may be new functions on every render.
  }, [id]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  const input = { name, description, body };
  if (!loaded) return <p className="admin-muted admin-tab">Loading…</p>;
  return (
    <section className="admin-tab">
      <button className="btn btn--ghost" onClick={onDone}>
        ← System
      </button>
      <h2 className="admin-h2">{id ? `Edit ${name}` : 'New persona'}</h2>
      <label className="admin-label">
        Name
        <input className="admin-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="admin-label">
        Description (only you see it)
        <input className="admin-input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="admin-label">
        Character (comes after the shared rules in the prompt)
        <textarea className="admin-input admin-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="admin-muted">Saved changes apply from each guest's next message.</p>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="card__actions">
        <button
          className="btn btn--primary"
          disabled={busy || !name.trim() || !body.trim()}
          onClick={() => void run(() => (id ? adminApi.updatePersona(id, input) : adminApi.createPersona(input)), `Saved ${name.trim()}`)}
        >
          Save
        </button>
        {id && hasDefault && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Reset ${name} to the version shipped with the app? Your changes are lost.`)) {
                void run(() => adminApi.restorePersona(id), `Reset ${name}`);
              }
            }}
          >
            Reset to default
          </button>
        )}
        {id && (
          <button
            className="btn btn--danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${name}? The file is moved to .trash.`)) {
                void run(() => adminApi.deletePersona(id), `Deleted ${name}`);
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </section>
  );
}

/** The rules every persona shares, first in every prompt. */
export function RulesEditor({ onDone, toast }: { onDone: () => void; toast: Toast }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.personaRules().then(setText, () => setText(''));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.savePersonaRules(text ?? '');
      toast('Saved the shared rules');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  if (text === null) return <p className="admin-muted admin-tab">Loading…</p>;
  return (
    <section className="admin-tab">
      <button className="btn btn--ghost" onClick={onDone}>
        ← System
      </button>
      <h2 className="admin-h2">Shared rules</h2>
      <p className="admin-muted">
        First in every persona's prompt: language, length, safety, "you can't give points". Keep the language rule at the
        top; tests showed it matters.
      </p>
      <label className="admin-label">
        Rules
        <textarea className="admin-input admin-textarea" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="card__actions">
        <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </section>
  );
}
