import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults required by the plan', () => {
    const c = parseConfig({}, '/base');
    expect(c.ollama.numCtx).toBe(4096);
    expect(c.ollama.connectTimeoutMs).toBe(3000);
    expect(c.ollama.firstTokenTimeoutMs).toBe(45000);
    expect(c.chat.maxInputChars).toBe(500);
    expect(c.chat.historyTurns).toBe(8);
    expect(c.sseHeartbeatMs).toBe(20000);
  });

  it('resolves relative paths against the base dir and keeps absolute ones', () => {
    const c = parseConfig({ PERSONAS_DIR: 'content/p', WEB_DIST: '/srv/web' }, '/base');
    expect(c.chat.personasDir).toBe(path.resolve('/base/content/p'));
    expect(c.chat.defaultPersona).toBe('sadgpt');
    expect(c.webDist).toBe('/srv/web');
  });

  it('coerces numbers and strips trailing slashes from the Ollama URL', () => {
    const c = parseConfig({ PORT: '8080', OLLAMA_URL: 'http://127.0.0.1:11435/' }, '/');
    expect(c.port).toBe(8080);
    expect(c.ollama.url).toBe('http://127.0.0.1:11435');
  });

  it('parses rate limits, booleans and admin settings', () => {
    const c = parseConfig(
      { RATE_CHAT_SESSION: '3/10', ADMIN_COOKIE_SECURE: 'false', ADMIN_PASSWORD: 'longenough', DB_PATH: ':memory:' },
      '/base',
    );
    expect(c.rateLimits.chatPerSession).toEqual({ count: 3, windowMs: 10_000 });
    expect(c.rateLimits.chatPerIp).toEqual({ count: 120, windowMs: 60_000 });
    expect(c.admin).toMatchObject({ password: 'longenough', cookieSecure: false });
    expect(c.dbPath).toBe(':memory:');
    expect(parseConfig({}, '/base').admin).toMatchObject({ password: null, cookieSecure: true });
    expect(parseConfig({ ADMIN_PASSWORD: '' }, '/base').admin.password).toBeNull();
  });

  it('has model timeouts suited to a single model with no fallback', () => {
    expect(parseConfig({}, '/').ollama).toMatchObject({ connectTimeoutMs: 3000, firstTokenTimeoutMs: 45000, checkIntervalMs: 5000 });
    // Old .env files may still have the fallback settings; they are ignored.
    expect(() => parseConfig({ OLLAMA_FALLBACK_URL: 'http://127.0.0.1:11434', OLLAMA_PRIMARY_RETRY_MS: '0' }, '/')).not.toThrow();
  });

  it('rejects invalid values with a readable error', () => {
    expect(() => parseConfig({ ADMIN_PASSWORD: 'short' }, '/')).toThrow(/ADMIN_PASSWORD/);
    expect(() => parseConfig({ RATE_CHAT_IP: 'lots' }, '/')).toThrow(/RATE_CHAT_IP/);
    expect(() => parseConfig({ PORT: 'abc' }, '/')).toThrow(/PORT/);
    expect(() => parseConfig({ OLLAMA_URL: 'not a url' }, '/')).toThrow(/OLLAMA_URL/);
  });
});
