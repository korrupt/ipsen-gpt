import { useEffect, useState } from 'react';
import {
  adminApi,
  ago,
  STATE_LABELS,
  type AdminGate,
  type AdminMessage,
  type AdminPerson,
  type AdminPhoto,
  type AdminSession,
  type GateDefinition,
} from './api';
import { ForceGateForm, GateCard } from './GatesTab';
import { PersonaSelect, usePersonas } from './PersonaSelect';
import { PhotoDetail, PhotoGrid } from './PhotosTab';
import { AwardForm } from './PointsTab';
import { usePoll } from './usePoll';

interface Props {
  toast: (msg: string) => void;
}

export function SessionsTab({ toast }: Props) {
  const { data: sessions, reload } = usePoll(adminApi.sessions, 5000);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  if (selected) {
    return (
      <SessionDetail
        id={selected}
        toast={toast}
        onBack={() => {
          setSelected(null);
          void reload();
        }}
      />
    );
  }

  const f = filter.trim().toLowerCase();
  const shown = (sessions ?? []).filter((s) => !f || (s.name ?? '').toLowerCase().includes(f));

  return (
    <section className="admin-tab">
      <input
        className="admin-input"
        placeholder="Filter by name"
        aria-label="Filter sessions by name"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {sessions === null && <p className="admin-muted">Loading…</p>}
      {sessions !== null && shown.length === 0 && <p className="admin-muted">No sessions.</p>}
      <ul className="admin-list">
        {shown.map((s) => (
          <li key={s.id}>
            <button className="card card--button" onClick={() => setSelected(s.id)} data-testid="session-row">
              <div className="card__row">
                <strong>{s.name ?? <em>no name</em>}</strong>
                <span className={`badge badge--${s.state}`}>{STATE_LABELS[s.state]}</span>
              </div>
              <div className="admin-muted">
                {s.person ? `${s.person.name} · ` : ''}
                {s.points} pts · {s.messageCount ?? 0} msgs · seen {ago(s.lastSeenAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionDetail({ id, onBack, toast }: { id: string; onBack: () => void; toast: (msg: string) => void }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [people, setPeople] = useState<AdminPerson[]>([]);
  const [gates, setGates] = useState<AdminGate[]>([]);
  const [photos, setPhotos] = useState<AdminPhoto[]>([]);
  const [definitions, setDefinitions] = useState<GateDefinition[]>([]);
  const [openPhoto, setOpenPhoto] = useState<AdminPhoto | null>(null);
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [personas] = usePersonas();

  const load = async () => {
    try {
      const r = await adminApi.session(id);
      setSession(r.session);
      setMessages(r.messages);
      setGates(r.gates);
      setPhotos(r.photos);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
      onBack();
    }
  };

  useEffect(() => {
    void load();
    void adminApi.people().then((r) => setPeople(r.people), () => {});
    void adminApi.gates().then((r) => setDefinitions(r.definitions), () => {});
  }, [id]);

  const run = async (label: string, fn: () => Promise<unknown>, after: 'reload' | 'back' = 'reload') => {
    setBusy(true);
    try {
      await fn();
      toast(label);
      if (after === 'back') onBack();
      else await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!session) return <p className="admin-muted admin-tab">Loading…</p>;
  if (openPhoto) {
    return (
      <PhotoDetail
        photo={openPhoto}
        toast={toast}
        onBack={() => setOpenPhoto(null)}
        onDeleted={() => {
          setOpenPhoto(null);
          void load();
        }}
      />
    );
  }

  return (
    <section className="admin-tab">
      <button className="btn btn--ghost" onClick={onBack}>
        ← Sessions
      </button>
      <div className="card">
        <div className="card__row">
          <h2 className="admin-h2">{session.name ?? <em>no name</em>}</h2>
          <span className={`badge badge--${session.state}`}>{STATE_LABELS[session.state]}</span>
        </div>
        {session.person && <div>Person: {session.person.name}</div>}
        {session.claimCode && (
          <div>
            Claim code <strong>{session.claimCode}</strong> for {session.claimPeople.map((p) => p.name).join(' or ') || '?'}
          </div>
        )}
        <div className="admin-muted">
          Started {ago(session.createdAt)} · seen {ago(session.lastSeenAt)}
        </div>
      </div>

      <div className="card">
        <label className="admin-label" htmlFor="assign">
          Assign person
        </label>
        <div className="card__actions">
          <select id="assign" className="admin-input" value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
                {p.claimedBy && p.claimedBy.id !== session.id ? ` (now: ${p.claimedBy.name})` : ''}
              </option>
            ))}
          </select>
          <button
            className="btn btn--primary"
            disabled={!slug || busy}
            onClick={() => void run('Person assigned', () => adminApi.assign(session.id, slug))}
          >
            Assign
          </button>
        </div>
      </div>

      <div className="card">
        <PersonaSelect
          id="session-persona"
          label="Persona for this guest"
          value={session.personaId}
          personas={personas}
          disabled={busy}
          fallbackLabel={session.person?.hasCustomPersona ? `${session.person.name}'s own persona (People)` : undefined}
          onChange={(personaId) => void run('Persona changed', () => adminApi.setSessionPersona(session.id, personaId))}
        />
      </div>

      <h3 className="admin-h3">Points: {session.points}</h3>
      <AwardForm sessionId={session.id} toast={toast} onDone={() => void load()} />

      <div className="card__actions">
        <button
          className="btn"
          disabled={busy || session.name === null}
          onClick={() => void run('Name released', () => adminApi.releaseName(session.id))}
        >
          Release name
        </button>
        <button
          className="btn btn--danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`End ${session.name ?? 'this'} session? They'll have to start over.`)) {
              void run('Session ended', () => adminApi.endSession(session.id), 'back');
            }
          }}
        >
          End session
        </button>
      </div>

      <h3 className="admin-h3">Gates ({gates.length})</h3>
      <ForceGateForm definitions={definitions} sessionId={session.id} toast={toast} onDone={() => void load()} />
      <ul className="admin-list">
        {gates.map((g) => (
          <li key={g.id}>
            <GateCard
              gate={g}
              showName={false}
              onCancel={() => void run('Gate cancelled', () => adminApi.cancelGate(g.id))}
            />
          </li>
        ))}
      </ul>

      {photos.length > 0 && (
        <>
          <h3 className="admin-h3">Photos ({photos.length})</h3>
          <PhotoGrid photos={photos} onOpen={setOpenPhoto} />
        </>
      )}

      <h3 className="admin-h3">Chat ({messages.length})</h3>
      <ol className="admin-chat">
        {messages.map((m, i) => (
          <li key={i} className={`admin-chat__msg admin-chat__msg--${m.role}`}>
            {m.content}
          </li>
        ))}
      </ol>
    </section>
  );
}
