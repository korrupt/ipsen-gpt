import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** "count/seconds", e.g. "8/60" = 8 requests per 60 s. */
const RateLimit = z
  .string()
  .regex(/^\d+\/\d+$/, 'expected "count/seconds", e.g. "8/60"')
  .transform((v) => {
    const [count, seconds] = v.split('/').map(Number) as [number, number];
    return { count, windowMs: seconds * 1000 };
  });

const Bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const ConfigSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),

  OLLAMA_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3-vl:4b-instruct'),
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(4096),
  OLLAMA_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),
  OLLAMA_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  OLLAMA_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OLLAMA_REPLY_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  OLLAMA_FALLBACK_URL: z.union([z.literal(''), z.url()]).default(''),
  OLLAMA_FALLBACK_MODEL: z.string().min(1).default('llama3.2:1b'),
  OLLAMA_PRIMARY_RETRY_MS: z.coerce.number().int().min(0).default(30000),

  PERSONA_PATH: z.string().default('content/persona.md'),
  CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(500),
  CHAT_HISTORY_TURNS: z.coerce.number().int().min(0).default(8),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20000),

  WEB_DIST: z.string().default('apps/web/dist'),

  DB_PATH: z.string().default('data/ipsengpt.sqlite'),
  PEOPLE_DIR: z.string().default('data/people'),
  GATES_PATH: z.string().default('content/gates.json'),
  PHOTOS_DIR: z.string().default('data/photos'),

  /** A photo passes only if the model says yes with at least this confidence. */
  PHOTO_CONFIDENCE_MIN: z.coerce.number().min(0).max(1).default(0.7),
  PHOTO_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  PHOTO_MAX_ORIGINAL_MB: z.coerce.number().positive().max(24).default(20),

  ADMIN_PASSWORD: z
    .string()
    .refine((v) => v === '' || v.length >= 8, 'must be at least 8 characters')
    .optional(),
  ADMIN_COOKIE_SECURE: Bool.default(true),
  ADMIN_SESSION_HOURS: z.coerce.number().positive().default(24),

  RATE_CHAT_SESSION: RateLimit.prefault('8/60'),
  RATE_CHAT_IP: RateLimit.prefault('120/60'),
  RATE_SESSION_CREATE_IP: RateLimit.prefault('30/600'),
  RATE_ADMIN_LOGIN_IP: RateLimit.prefault('5/900'),
  RATE_PHOTO_SESSION: RateLimit.prefault('1/15'),
  RATE_PHOTO_IP: RateLimit.prefault('60/60'),
});

export interface RateLimitRule {
  count: number;
  windowMs: number;
}

export interface Config {
  host: string;
  port: number;
  ollama: {
    /** Primary endpoint (the PC, via the SSH tunnel in production). */
    url: string;
    model: string;
    numCtx: number;
    temperature: number;
    /** Give up if Ollama doesn't even answer a health check within this. */
    connectTimeoutMs: number;
    /** Give up if Ollama is alive but sends no first token within this (busy/queued). */
    firstTokenTimeoutMs: number;
    replyTimeoutMs: number;
    /** Used when the primary fails before replying. Null = no fallback. */
    fallback: { url: string; model: string } | null;
    /** After the primary fails, skip it for this long before trying it again. */
    primaryRetryMs: number;
  };
  chat: {
    personaPath: string;
    maxInputChars: number;
    historyTurns: number;
  };
  sseHeartbeatMs: number;
  webDist: string;
  /** SQLite file, or ':memory:'. */
  dbPath: string;
  peopleDir: string;
  gatesPath: string;
  photos: {
    dir: string;
    confidenceMin: number;
    verifyTimeoutMs: number;
    maxOriginalBytes: number;
  };
  admin: {
    /** Admin is disabled when unset. */
    password: string | null;
    cookieSecure: boolean;
    sessionTtlMs: number;
  };
  rateLimits: {
    chatPerSession: RateLimitRule;
    chatPerIp: RateLimitRule;
    sessionCreatePerIp: RateLimitRule;
    adminLoginPerIp: RateLimitRule;
    photoPerSession: RateLimitRule;
    photoPerIp: RateLimitRule;
  };
}

/** Walk up from `start` looking for a file; returns its directory or null. */
function findUp(fileName: string, start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, fileName))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads `.env` (if present) into process.env and returns the base directory
 * that relative paths in the config resolve against: the `.env` directory,
 * else the workspace root, else cwd.
 */
export function loadEnvFile(cwd = process.cwd()): string {
  const explicit = process.env.ENV_FILE;
  if (explicit) {
    process.loadEnvFile(explicit);
    return path.dirname(path.resolve(explicit));
  }
  const envDir = findUp('.env', cwd);
  if (envDir) {
    process.loadEnvFile(path.join(envDir, '.env'));
    return envDir;
  }
  return findUp('pnpm-workspace.yaml', cwd) ?? cwd;
}

export function parseConfig(env: Record<string, string | undefined>, baseDir: string): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  const resolve = (p: string) => path.resolve(baseDir, p);
  return {
    host: e.HOST,
    port: e.PORT,
    ollama: {
      url: e.OLLAMA_URL.replace(/\/+$/, ''),
      model: e.OLLAMA_MODEL,
      numCtx: e.OLLAMA_NUM_CTX,
      temperature: e.OLLAMA_TEMPERATURE,
      connectTimeoutMs: e.OLLAMA_CONNECT_TIMEOUT_MS,
      firstTokenTimeoutMs: e.OLLAMA_FIRST_TOKEN_TIMEOUT_MS,
      replyTimeoutMs: e.OLLAMA_REPLY_TIMEOUT_MS,
      fallback: e.OLLAMA_FALLBACK_URL
        ? { url: e.OLLAMA_FALLBACK_URL.replace(/\/+$/, ''), model: e.OLLAMA_FALLBACK_MODEL }
        : null,
      primaryRetryMs: e.OLLAMA_PRIMARY_RETRY_MS,
    },
    chat: {
      personaPath: resolve(e.PERSONA_PATH),
      maxInputChars: e.CHAT_MAX_INPUT_CHARS,
      historyTurns: e.CHAT_HISTORY_TURNS,
    },
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    webDist: resolve(e.WEB_DIST),
    dbPath: e.DB_PATH === ':memory:' ? e.DB_PATH : resolve(e.DB_PATH),
    peopleDir: resolve(e.PEOPLE_DIR),
    gatesPath: resolve(e.GATES_PATH),
    photos: {
      dir: resolve(e.PHOTOS_DIR),
      confidenceMin: e.PHOTO_CONFIDENCE_MIN,
      verifyTimeoutMs: e.PHOTO_VERIFY_TIMEOUT_MS,
      maxOriginalBytes: Math.round(e.PHOTO_MAX_ORIGINAL_MB * 1024 * 1024),
    },
    admin: {
      password: e.ADMIN_PASSWORD || null,
      cookieSecure: e.ADMIN_COOKIE_SECURE,
      sessionTtlMs: e.ADMIN_SESSION_HOURS * 3600_000,
    },
    rateLimits: {
      chatPerSession: e.RATE_CHAT_SESSION,
      chatPerIp: e.RATE_CHAT_IP,
      sessionCreatePerIp: e.RATE_SESSION_CREATE_IP,
      adminLoginPerIp: e.RATE_ADMIN_LOGIN_IP,
      photoPerSession: e.RATE_PHOTO_SESSION,
      photoPerIp: e.RATE_PHOTO_IP,
    },
  };
}
