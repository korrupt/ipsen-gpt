import { useState } from 'react';
import { adminApi, type AdminPerson } from './api';
import { usePoll } from './usePoll';

interface Props {
  toast: (msg: string) => void;
}

type Editing = { kind: 'new' } | { kind: 'edit'; person: AdminPerson } | null;

export function PeopleTab({ toast }: Props) {
  const { data, reload } = usePoll(adminApi.people, 15000);
  const [editing, setEditing] = useState<Editing>(null);

  if (editing) {
    return (
      <PersonEditor
        person={editing.kind === 'edit' ? editing.person : null}
        toast={toast}
        onDone={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <section className="admin-tab">
      <div className="card__actions">
        <button className="btn btn--primary" onClick={() => setEditing({ kind: 'new' })}>
          + New person
        </button>
        <button
          className="btn"
          onClick={() =>
            void adminApi.reloadPeople().then(
              () => {
                toast('Reloaded from disk');
                return reload();
              },
              () => toast('Reload failed'),
            )
          }
        >
          Reload from disk
        </button>
      </div>
      {data?.errors.map((e) => (
        <p key={e} className="admin-error">
          {e}
        </p>
      ))}
      {data === null && <p className="admin-muted">Loading…</p>}
      {data && data.people.length === 0 && <p className="admin-muted">No people yet.</p>}
      <ul className="admin-list">
        {data?.people.map((p) => (
          <li key={p.slug}>
            <button className="card card--button" onClick={() => setEditing({ kind: 'edit', person: p })} data-testid="person-row">
              <div className="card__row">
                <strong>{p.name}</strong>
                {p.claimedBy && <span className="badge badge--claimed">Here</span>}
              </div>
              <div className="admin-muted">
                {p.aliases.length ? `Also: ${p.aliases.join(', ')}` : 'No aliases'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const splitAliases = (s: string) =>
  s
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

function PersonEditor({ person, onDone, toast }: { person: AdminPerson | null; onDone: () => void; toast: (m: string) => void }) {
  const [name, setName] = useState(person?.name ?? '');
  const [aliases, setAliases] = useState(person?.aliases.join(', ') ?? '');
  const [info, setInfo] = useState(person?.info ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = { name, aliases: splitAliases(aliases), info };
      if (person) await adminApi.updatePerson(person.slug, input);
      else await adminApi.createPerson(input);
      toast(`Saved ${name}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!person || !window.confirm(`Delete ${person.name}? The folder is moved to .trash.`)) return;
    setBusy(true);
    try {
      await adminApi.deletePerson(person.slug);
      toast(`Deleted ${person.name}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
    }
  };

  return (
    <section className="admin-tab">
      <button className="btn btn--ghost" onClick={onDone}>
        ← People
      </button>
      <h2 className="admin-h2">{person ? `Edit ${person.name}` : 'New person'}</h2>
      {person?.claimedBy && <p className="admin-muted">Claimed by session “{person.claimedBy.name}”</p>}
      <label className="admin-label">
        Display name
        <input className="admin-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="admin-label">
        Aliases (comma separated; also reserve the person)
        <input className="admin-input" value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </label>
      <label className="admin-label">
        Info for IpsenGPT (only used in their own chat, after you approve them)
        <textarea className="admin-input admin-textarea" value={info} onChange={(e) => setInfo(e.target.value)} />
      </label>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="card__actions">
        <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          Save
        </button>
        {person && (
          <button className="btn btn--danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </section>
  );
}
