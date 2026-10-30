import { useEffect, useState } from 'react';
import { adminApi, type Personas } from './api';

/** The persona list, loaded once per screen. */
export function usePersonas(): [Personas | null, () => Promise<void>] {
  const [data, setData] = useState<Personas | null>(null);
  const reload = async () => setData(await adminApi.personas());
  useEffect(() => {
    void reload().catch(() => {});
  }, []);
  return [data, reload];
}

interface Props {
  id: string;
  label: string;
  /** null: "the global one". */
  value: string | null;
  onChange: (id: string | null) => void;
  personas: Personas | null;
  disabled?: boolean;
  /** What the first option (null) means here; default: the global persona. */
  fallbackLabel?: string;
  /** Extra option at the end, e.g. "custom". */
  extra?: { value: string; label: string };
}

/** Pick a persona for a guest or a person; the first option means "follow the global one". */
export function PersonaSelect({ id, label, value, onChange, personas, disabled, fallbackLabel, extra }: Props) {
  const global = personas?.personas.find((p) => p.id === personas.activeId);
  return (
    <>
      <label className="admin-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="admin-input"
        value={value ?? ''}
        disabled={disabled || !personas}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{fallbackLabel ?? `Global persona${global ? ` (now: ${global.name})` : ''}`}</option>
        {personas?.personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {extra && <option value={extra.value}>{extra.label}</option>}
      </select>
    </>
  );
}
