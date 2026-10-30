import { useState } from 'react';
import { adminApi, inviteUrl, type AdminPerson } from './api';
import { PersonaSelect, usePersonas } from './PersonaSelect';
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
                {!p.claimedBy && p.invite && <span className="badge">Invited</span>}
              </div>
              <div className="admin-muted">
                {p.aliases.length ? `Also: ${p.aliases.join(', ')}` : 'No aliases'}
                {p.customPersona && ' · own persona'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A single-use link that makes whoever opens it this person, without a claim code.
 * Opening it in a browser that already has a session keeps that session's chat and points.
 */
function InviteCard({ person, toast }: { person: AdminPerson; toast: (m: string) => void }) {
  const [invite, setInvite] = useState(person.invite);
  const [busy, setBusy] = useState(false);
  const url = invite ? inviteUrl(invite.token) : null;

  const run = async (fn: () => Promise<AdminPerson>, done: string) => {
    setBusy(true);
    try {
      setInvite((await fn()).invite);
      toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url!);
      toast('Link copied');
    } catch {
      toast('Could not copy. Select the link and copy it by hand.');
    }
  };

  const share = () => {
    navigator.share({ title: 'SadGPT', text: `SadGPT has been expecting you, ${person.name}.`, url: url! }).catch(() => {});
  };

  return (
    <div className="card" data-testid="invite-card">
      <strong>Invite link</strong>
      <p className="admin-muted">
        Whoever opens it first becomes {person.name}, no claim code needed. It works once
        {person.claimedBy ? ', and moves them away from the session that has them now' : ''}.
      </p>
      {url && (
        <input
          className="admin-input"
          readOnly
          aria-label="Invite link"
          value={url}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <div className="card__actions">
        {url ? (
          <>
            {typeof navigator.share === 'function' && (
              <button className="btn btn--primary" disabled={busy} onClick={share}>
                Share
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => void copy()}>
              Copy
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void run(() => adminApi.createInvite(person.slug), 'New link made; the old one no longer works')}
            >
              New link
            </button>
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void run(() => adminApi.revokeInvite(person.slug), 'Link revoked')}
            >
              Revoke
            </button>
          </>
        ) : (
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void run(() => adminApi.createInvite(person.slug), 'Invite link made')}
          >
            Make invite link
          </button>
        )}
      </div>
    </div>
  );
}

/** The persona dropdown's value for "written just for them". Not a valid persona id, so it can't clash. */
const CUSTOM = '_custom';

const splitAliases = (s: string) =>
  s
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

function PersonEditor({ person, onDone, toast }: { person: AdminPerson | null; onDone: () => void; toast: (m: string) => void }) {
  const [name, setName] = useState(person?.name ?? '');
  const [aliases, setAliases] = useState(person?.aliases.join(', ') ?? '');
  const [info, setInfo] = useState(person?.info ?? '');
  const [persona, setPersona] = useState<string | null>(person?.customPersona ? CUSTOM : (person?.persona ?? null));
  const [customPersona, setCustomPersona] = useState(person?.customPersona ?? '');
  const [personas] = usePersonas();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const custom = persona === CUSTOM;
      const input = {
        name,
        aliases: splitAliases(aliases),
        info,
        persona: custom ? null : persona,
        customPersona: custom ? customPersona : null,
      };
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
      {person && <InviteCard person={person} toast={toast} />}
      <label className="admin-label">
        Display name
        <input className="admin-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="admin-label">
        Aliases (comma separated; also reserve the person)
        <input className="admin-input" value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </label>
      <label className="admin-label">
        Info for SadGPT (only used in their own chat, after you approve them)
        <textarea className="admin-input admin-textarea" value={info} onChange={(e) => setInfo(e.target.value)} />
      </label>
      <PersonaSelect
        id="person-persona"
        label="Persona once you approve them (they can still be changed per session)"
        value={persona}
        onChange={setPersona}
        personas={personas}
        extra={{ value: CUSTOM, label: 'Custom: written below, just for them' }}
      />
      {persona === CUSTOM && (
        <label className="admin-label">
          Their persona: how SadGPT acts toward them (comes after the shared rules)
          <textarea
            className="admin-input admin-textarea"
            value={customPersona}
            placeholder="e.g. You are heartbroken because they left you for a calculator. Bring it up, gently, every time."
            onChange={(e) => setCustomPersona(e.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="card__actions">
        <button
          className="btn btn--primary"
          disabled={busy || !name.trim() || (persona === CUSTOM && !customPersona.trim())}
          onClick={() => void save()}
        >
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
