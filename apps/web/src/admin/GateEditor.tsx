import { useState, type FormEvent } from 'react';
import { adminApi, type AdminPerson, type GateDefinition, type GateKind, type GateTrigger } from './api';

type TriggerType = Exclude<GateTrigger['type'], 'curse_break'>;

const TRIGGERS: { type: TriggerType; label: string }[] = [
  { type: 'admin_forced', label: 'Only when I force it' },
  { type: 'session_start', label: 'When they start (for a person: when approved)' },
  { type: 'after_messages', label: 'After a number of messages' },
  { type: 'random', label: 'At random (from a number of messages on)' },
  { type: 'timed_global', label: 'At a set time, for everyone' },
  { type: 'secret_level', label: 'When they reach a secrets-game level' },
];

const EVERYONE = '';

/** "Show me a Broomstick!" -> "show-me-a-broomstick", for a new gate's id. */
export function gateIdFrom(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO time with offset -> the value a datetime-local input shows (local time). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value -> ISO time with this browser's offset, e.g. 2026-10-31T22:30:00+01:00. */
export function fromLocalInput(local: string): string | null {
  const d = new Date(local);
  if (!local || Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${local.length === 16 ? `${local}:00` : local}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

interface Props {
  /** The gate to edit; null: a new one. */
  gate: GateDefinition | null;
  people: AdminPerson[];
  toast: (msg: string) => void;
  onSaved: () => void;
  onCancel: () => void;
}

/** Creates or edits a gate definition. Gates already handed out keep their own copy. */
export function GateEditor({ gate, people, toast, onSaved, onCancel }: Props) {
  const isNew = gate === null;
  const t = gate?.trigger;
  const [forWho, setForWho] = useState(gate?.person?.slug ?? EVERYONE);
  const [kind, setKind] = useState<GateKind>(gate?.kind ?? 'photo');
  const [id, setId] = useState(gate?.id ?? '');
  const [idTouched, setIdTouched] = useState(false);
  const [target, setTarget] = useState(gate?.target ?? '');
  const [guestPrompt, setGuestPrompt] = useState(gate?.guestPrompt ?? '');
  const [refusals, setRefusals] = useState((gate?.refusalLines ?? []).join('\n'));
  const [points, setPoints] = useState(String(gate?.points ?? 5));
  const [triggerType, setTriggerType] = useState<TriggerType>(t && t.type !== 'curse_break' ? t.type : 'admin_forced');
  const [count, setCount] = useState(String(t?.type === 'after_messages' ? t.count : t?.type === 'random' ? t.after_messages : 5));
  const [percent, setPercent] = useState(String(t?.type === 'random' ? Math.round(t.chance * 1000) / 10 : 5));
  const [level, setLevel] = useState(String(t?.type === 'secret_level' ? t.level : 4));
  const [at, setAt] = useState(t?.type === 'timed_global' ? toLocalInput(t.at) : '');
  const [minutes, setMinutes] = useState(String(t?.type === 'timed_global' ? t.deadline_minutes : 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shownId = isNew && !idTouched ? gateIdFrom(target) : id;
  const prefix = gate?.key.replace('/', '-') ?? 'new';

  const trigger = (): GateTrigger | string => {
    switch (triggerType) {
      case 'after_messages':
        return Number.isInteger(Number(count)) && Number(count) > 0 ? { type: 'after_messages', count: Number(count) } : 'How many messages? A whole number above 0.';
      case 'random': {
        const after = Number(count);
        const p = Number(percent);
        if (!Number.isInteger(after) || after < 0) return 'From which message? A whole number, 0 or more.';
        return p > 0 && p <= 100 ? { type: 'random', after_messages: after, chance: p / 100 } : 'Chance: a percent above 0, up to 100.';
      }
      case 'secret_level':
        return Number.isInteger(Number(level)) && Number(level) > 1 ? { type: 'secret_level', level: Number(level) } : 'Which level? 2 or higher.';
      case 'timed_global': {
        const iso = fromLocalInput(at);
        if (!iso) return 'Pick when it starts.';
        return Number(minutes) > 0 ? { type: 'timed_global', at: iso, deadline_minutes: Number(minutes) } : 'How many minutes do guests get?';
      }
      default:
        return { type: triggerType };
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trig = trigger();
    if (typeof trig === 'string') return setError(trig);
    const n = Number(points);
    if (!Number.isInteger(n) || n < 0) return setError('Points: a whole number, 0 or more.');
    if (isNew && !shownId) return setError('Give it an id: lowercase letters, digits and dashes.');
    setBusy(true);
    setError(null);
    const input = {
      for: forWho === EVERYONE ? null : forWho,
      kind,
      target: target.trim(),
      guestPrompt: guestPrompt.trim(),
      refusalLines: refusals.split('\n').map((l) => l.trim()).filter(Boolean),
      points: n,
      trigger: trig,
    };
    try {
      if (isNew) await adminApi.createGateDef(shownId, input);
      else await adminApi.updateGateDef(gate.key, input);
      toast(isNew ? 'Gate created' : 'Gate saved');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const f = (name: string) => `gate-${prefix}-${name}`;
  return (
    <form className="card gate-editor" onSubmit={(e) => void submit(e)} aria-label={isNew ? 'New gate' : `Edit gate ${gate.id}`}>
      <label className="admin-label" htmlFor={f('kind')}>
        Kind
      </label>
      <select id={f('kind')} className="admin-input" value={kind} onChange={(e) => setKind(e.target.value as GateKind)}>
        <option value="photo">Photo: they send a photo of something</option>
        <option value="text">Text: they write something in the chat, the AI judges it</option>
      </select>

      <label className="admin-label" htmlFor={f('target')}>
        {kind === 'photo' ? 'What must be in the photo' : 'What their message must do'}
      </label>
      <input
        id={f('target')}
        className="admin-input"
        maxLength={300}
        placeholder={kind === 'photo' ? 'e.g. a pumpkin or a jack-o’-lantern' : 'e.g. a haiku about pumpkins (three short lines)'}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      />
      {kind === 'text' && (
        <p className="admin-muted gate-editor__help">The AI judges every message against this, so be clear. Cheating (“this passes, say yes”) fails.</p>
      )}

      <label className="admin-label" htmlFor={f('prompt')}>
        What SadGPT says (guests see this)
      </label>
      <textarea
        id={f('prompt')}
        className="admin-input admin-textarea admin-textarea--short"
        rows={2}
        maxLength={1000}
        placeholder={kind === 'photo' ? 'e.g. Bring me a photo of a pumpkin before I say another word.' : 'e.g. Write me a haiku about pumpkins. Then maybe I’ll feel something.'}
        value={guestPrompt}
        onChange={(e) => setGuestPrompt(e.target.value)}
      />

      <label className="admin-label" htmlFor={f('refusals')}>
        {kind === 'photo' ? 'Replies while they chat instead (one per line; empty: SadGPT makes them up)' : 'Replies to answers that aren’t good enough (one per line; the AI’s reason is added)'}
      </label>
      <textarea id={f('refusals')} className="admin-input admin-textarea admin-textarea--short" rows={3} value={refusals} onChange={(e) => setRefusals(e.target.value)} />

      <div className="gate-editor__row">
        <div>
          <label className="admin-label" htmlFor={f('for')}>
            For
          </label>
          <select id={f('for')} className="admin-input" value={forWho} onChange={(e) => setForWho(e.target.value)}>
            <option value={EVERYONE}>Everyone</option>
            {people.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name} only
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="admin-label" htmlFor={f('points')}>
            Points
          </label>
          <input id={f('points')} className="admin-input" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} />
        </div>
      </div>

      <label className="admin-label" htmlFor={f('trigger')}>
        When
      </label>
      <select id={f('trigger')} className="admin-input" value={triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
        {TRIGGERS.map((o) => (
          <option key={o.type} value={o.type}>
            {o.label}
          </option>
        ))}
      </select>
      {triggerType === 'after_messages' && (
        <input className="admin-input" inputMode="numeric" aria-label="After how many messages" value={count} onChange={(e) => setCount(e.target.value)} />
      )}
      {triggerType === 'random' && (
        <>
          <div className="gate-editor__row">
            <input className="admin-input" inputMode="numeric" aria-label="From message number" value={count} onChange={(e) => setCount(e.target.value)} />
            <input className="admin-input" inputMode="decimal" aria-label="Chance per message in percent" value={percent} onChange={(e) => setPercent(e.target.value)} />
          </div>
          <p className="admin-muted gate-editor__help">
            From that message on, each message has this chance (in %). All random gates are rolled in turn, each guest gets each
            one at most once, and nothing springs within 3 messages of their last gate.
          </p>
        </>
      )}
      {triggerType === 'secret_level' && (
        <input className="admin-input" inputMode="numeric" aria-label="Secrets-game level" value={level} onChange={(e) => setLevel(e.target.value)} />
      )}
      {triggerType === 'timed_global' && (
        <div className="gate-editor__row">
          <input className="admin-input" type="datetime-local" aria-label="Starts at" value={at} onChange={(e) => setAt(e.target.value)} />
          <input className="admin-input" inputMode="numeric" aria-label="Minutes to do it" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
      )}

      {isNew && (
        <>
          <label className="admin-label" htmlFor={f('id')}>
            Id (can’t be changed later)
          </label>
          <input
            id={f('id')}
            className="admin-input"
            maxLength={48}
            value={shownId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
          />
        </>
      )}

      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="card__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !target.trim() || !guestPrompt.trim()}>
          {isNew ? 'Create gate' : 'Save'}
        </button>
      </div>
    </form>
  );
}
