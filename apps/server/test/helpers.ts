import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type Config } from '../src/config.js';

export const TEST_PERSONA = 'You are TestGhost. SECRET-PERSONA-MARKER.';

export function makeConfig(overrides: Record<string, string> = {}): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipsengpt-test-'));
  fs.writeFileSync(path.join(dir, 'persona.md'), TEST_PERSONA);
  return parseConfig(
    {
      PERSONA_PATH: 'persona.md',
      WEB_DIST: 'no-such-dist',
      OLLAMA_CONNECT_TIMEOUT_MS: '500',
      OLLAMA_REPLY_TIMEOUT_MS: '5000',
      ...overrides,
    },
    dir,
  );
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses a complete SSE body into events, ignoring comments. */
export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l && !l.startsWith(':')))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
      const data = lines
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}
