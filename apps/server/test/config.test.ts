import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults required by the plan', () => {
    const c = parseConfig({}, '/base');
    expect(c.ollama.numCtx).toBe(4096);
    expect(c.ollama.connectTimeoutMs).toBe(3000);
    expect(c.chat.maxInputChars).toBe(500);
    expect(c.chat.historyTurns).toBe(8);
    expect(c.sseHeartbeatMs).toBe(20000);
  });

  it('resolves relative paths against the base dir and keeps absolute ones', () => {
    const c = parseConfig({ PERSONA_PATH: 'content/p.md', WEB_DIST: '/srv/web' }, '/base');
    expect(c.chat.personaPath).toBe(path.resolve('/base/content/p.md'));
    expect(c.webDist).toBe('/srv/web');
  });

  it('coerces numbers and strips trailing slashes from the Ollama URL', () => {
    const c = parseConfig({ PORT: '8080', OLLAMA_URL: 'http://127.0.0.1:11435/' }, '/');
    expect(c.port).toBe(8080);
    expect(c.ollama.url).toBe('http://127.0.0.1:11435');
  });

  it('rejects invalid values with a readable error', () => {
    expect(() => parseConfig({ PORT: 'abc' }, '/')).toThrow(/PORT/);
    expect(() => parseConfig({ OLLAMA_URL: 'not a url' }, '/')).toThrow(/OLLAMA_URL/);
  });
});
