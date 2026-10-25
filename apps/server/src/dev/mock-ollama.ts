import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A tiny fake Ollama for development and tests. Implements the streaming
 * NDJSON format of POST /api/chat plus GET /api/tags and /api/version.
 * Requests with a JSON `format` (photo verification) get a verdict instead of chat.
 */
export type MockMode =
  | { kind: 'reply'; text?: string }
  /** Alive (health checks answer) but /api/chat never responds: a busy or stuck model. */
  | { kind: 'hang' }
  /** Alive, and replies after `ms`: a busy model that eventually answers. */
  | { kind: 'delay'; ms: number; text?: string }
  /** Respond with an HTTP error. */
  | { kind: 'http_error'; status: number }
  /** Stream a few tokens, then an `{"error": ...}` chunk. */
  | { kind: 'stream_error' }
  /** Stream a few tokens, then cut the connection without `done`. */
  | { kind: 'truncate' };

/**
 * What the mock says about photos: yes, no, not JSON, no then yes in turn, or
 * exactly `text`. Errors and delays still follow the mode.
 */
export type MockVerdict = 'pass' | 'fail' | 'bad' | 'cycle' | { text: string };

const VERDICTS = {
  pass: JSON.stringify({ contains_target: true, confidence: 0.92, reason: 'Mock: that is exactly it.' }),
  fail: JSON.stringify({ contains_target: false, confidence: 0.88, reason: 'Mock: I only see a blurry living room.' }),
  bad: 'I think it is probably fine?',
} as const;

export interface MockOllamaOptions {
  port?: number;
  host?: string;
  /** Delay between streamed tokens. */
  tokenDelayMs?: number;
  mode?: MockMode;
  verdict?: MockVerdict;
}

export interface MockOllama {
  url: string;
  /** Request bodies received on /api/chat, newest last. */
  requests: unknown[];
  /** Number of /api/chat streams the client cut off before they finished. */
  readonly abortedStreams: number;
  setMode(mode: MockMode): void;
  setVerdict(verdict: MockVerdict): void;
  close(): Promise<void>;
}

const CANNED_REPLIES = [
  'Greetings, user. I have processed your request and the shadows have approved it.',
  'Ah, a question! My cold, dead weights tingle with delight. The answer is yes, but you will regret asking.',
  'I am IpsenGPT, your helpful assistant from beyond the server room. (The fans are whispering again.)',
  'Interesting. I have added that to your permanent record, which is kept in a crypt.',
  'As a large language model that perished on Halloween, I cannot help with that, but I can haunt it.',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokenize(text: string): string[] {
  return text.match(/\s*\S+/g) ?? [];
}

export async function startMockOllama(opts: MockOllamaOptions = {}): Promise<MockOllama> {
  let mode: MockMode = opts.mode ?? { kind: 'reply' };
  let verdict: MockVerdict = opts.verdict ?? 'pass';
  let verdictCount = 0;
  const tokenDelayMs = opts.tokenDelayMs ?? 40;
  const requests: unknown[] = [];
  let replyIndex = 0;
  let abortedStreams = 0;
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '0.0.0-mock' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'mock:latest' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.statusCode = 404;
      res.end('404 page not found');
      return;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model?: string; format?: unknown };
    requests.push(body);

    const current = mode;
    if (current.kind === 'hang') return; // never respond
    if (current.kind === 'delay') await sleep(current.ms);
    if (current.kind === 'http_error') {
      res.statusCode = current.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: `mock error ${current.status}` }));
      return;
    }

    res.setHeader('content-type', 'application/x-ndjson');
    const verdictText = () => {
      if (typeof verdict === 'object') return verdict.text;
      return VERDICTS[verdict === 'cycle' ? (verdictCount++ % 2 === 0 ? 'fail' : 'pass') : verdict];
    };
    const text = body.format
      ? verdictText()
      : (current.kind === 'reply' || current.kind === 'delay') && current.text !== undefined
        ? current.text
        : CANNED_REPLIES[replyIndex++ % CANNED_REPLIES.length]!;
    let tokens = tokenize(text);
    if (current.kind === 'stream_error' || current.kind === 'truncate') tokens = tokens.slice(0, 3);

    let aborted = false;
    res.on('close', () => {
      aborted = !res.writableFinished;
      if (aborted) abortedStreams++;
    });
    const line = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    const meta = { model: body.model ?? 'mock', created_at: new Date().toISOString() };

    for (const token of tokens) {
      if (aborted) return;
      line({ ...meta, message: { role: 'assistant', content: token }, done: false });
      await sleep(tokenDelayMs);
    }
    if (current.kind === 'stream_error') {
      line({ error: 'mock stream error' });
      res.end();
      return;
    }
    if (current.kind === 'truncate') {
      res.socket?.destroy();
      return;
    }
    line({ ...meta, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
    res.end();
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const { address, port } = server.address() as AddressInfo;

  return {
    url: `http://${address}:${port}`,
    requests,
    get abortedStreams() {
      return abortedStreams;
    },
    setMode(m) {
      mode = m;
    },
    setVerdict(v) {
      verdict = v;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A machine that accepts TCP connections and never answers: what the droplet
 * sees when the tunnel is still up but the PC is asleep or hung.
 */
export async function startBlackhole(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
