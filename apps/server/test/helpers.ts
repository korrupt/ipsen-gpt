import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseConfig, type Config } from '../src/config.js';
import { createServices, type Services } from '../src/services.js';

export const TEST_PERSONA = 'You are TestGhost. SECRET-PERSONA-MARKER.';
export const ADMIN_PASSWORD = 'correct-horse';

export function tempDir(prefix = 'ipsengpt-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A URL whose port refuses connections: bind a free port, then release it.
 * Not 127.0.0.1: WSL2's mirrored networking drops connections to closed ports
 * there instead of refusing them. Not ports like 1 or 9 either: fetch blocks
 * those itself, so no connection would be attempted at all.
 */
export async function refusedUrl(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.2:${port}`;
}

export function makeConfig(overrides: Record<string, string> = {}): Config {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'persona.md'), TEST_PERSONA);
  return parseConfig(
    {
      PERSONA_PATH: 'persona.md',
      WEB_DIST: 'no-such-dist',
      DB_PATH: ':memory:',
      PEOPLE_DIR: 'people',
      GATES_PATH: 'gates.json',
      PHOTOS_DIR: 'photos',
      ADMIN_PASSWORD,
      OLLAMA_CONNECT_TIMEOUT_MS: '500',
      OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '1500',
      OLLAMA_REPLY_TIMEOUT_MS: '5000',
      ...overrides,
    },
    dir,
  );
}

/** Writes a person folder directly, as you would by hand on the server. */
export function writePerson(peopleDir: string, slug: string, name: string, aliases: string[], info: string) {
  fs.mkdirSync(path.join(peopleDir, slug), { recursive: true });
  const fm = [`name: ${name}`, `aliases: [${aliases.map((a) => JSON.stringify(a)).join(', ')}]`].join('\n');
  fs.writeFileSync(path.join(peopleDir, slug, 'person.md'), `---\n${fm}\n---\n${info}\n`);
}

/** A gate in gates.json format (snake_case), with defaults for the boring fields. */
export function gateJson(id: string, trigger: object, over: Record<string, unknown> = {}) {
  return { id, target: `a ${id}`, guest_prompt: `Show me a ${id}!`, refusal_lines: [], points: 5, trigger, ...over };
}

export function writeGates(file: string, gates: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(gates, null, 2));
}

/**
 * A JPEG like a phone makes: EXIF with a device name and GPS position, and
 * optionally an orientation tag (6 = rotate 90° to show upright).
 */
export function phoneJpeg({ width = 1200, height = 800, orientation }: { width?: number; height?: number; orientation?: number } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 100, b: 0 } } })
    .jpeg()
    .withExif({ IFD0: { Make: 'SpookyPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '59/1 54/1 0/1' } });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

export interface TestEnv {
  config: Config;
  services: Services;
  app: ReturnType<typeof createApp>;
  logged: string[];
  /** Advance the fake clock. */
  tick(ms: number): void;
}

export function makeEnv(overrides: Record<string, string> = {}, setup?: (config: Config) => void): TestEnv {
  const config = makeConfig(overrides);
  setup?.(config);
  let now = 1_700_000_000_000;
  const logged: string[] = [];
  const services = createServices(config, { now: () => now, write: (msg) => logged.push(msg) });
  const app = createApp({ config, services });
  return { config, services, app, logged, tick: (ms) => (now += ms) };
}

/** Creates a guest session over HTTP and returns its token. */
export async function newGuest(env: TestEnv, name: string): Promise<{ token: string; body: any }> {
  const res = await request(env.app).post('/api/session').send({ name });
  if (res.status !== 201) throw new Error(`newGuest(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, body: res.body };
}

/** Logs in as admin and returns the Cookie header to send. */
export async function adminCookie(env: TestEnv): Promise<string> {
  const res = await request(env.app).post('/api/admin/login').send({ password: ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
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

export const tokenText = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === 'token')
    .map((e) => (e.data as { text: string }).text)
    .join('');
