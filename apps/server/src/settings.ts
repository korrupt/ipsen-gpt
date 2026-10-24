import type { Db } from './db.js';

/** Runtime switches the admin can flip; persisted so a restart keeps them. */
export interface SettingValues {
  forceFallback: boolean;
}

const DEFAULTS: SettingValues = {
  forceFallback: false,
};

export class Settings {
  constructor(private readonly db: Db) {}

  get<K extends keyof SettingValues>(key: K): SettingValues[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as SettingValues[K]) : DEFAULTS[key];
  }

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  all(): SettingValues {
    return { forceFallback: this.get('forceFallback') };
  }
}
