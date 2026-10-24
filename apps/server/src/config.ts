import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),

  OLLAMA_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3-vl:8b'),
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(4096),
  OLLAMA_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),
  OLLAMA_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  OLLAMA_REPLY_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  PERSONA_PATH: z.string().default('content/persona.md'),
  CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(500),
  CHAT_HISTORY_TURNS: z.coerce.number().int().min(0).default(8),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20000),

  WEB_DIST: z.string().default('apps/web/dist'),
});

export interface Config {
  host: string;
  port: number;
  ollama: {
    url: string;
    model: string;
    numCtx: number;
    temperature: number;
    connectTimeoutMs: number;
    replyTimeoutMs: number;
  };
  chat: {
    personaPath: string;
    maxInputChars: number;
    historyTurns: number;
  };
  sseHeartbeatMs: number;
  webDist: string;
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
      replyTimeoutMs: e.OLLAMA_REPLY_TIMEOUT_MS,
    },
    chat: {
      personaPath: resolve(e.PERSONA_PATH),
      maxInputChars: e.CHAT_MAX_INPUT_CHARS,
      historyTurns: e.CHAT_HISTORY_TURNS,
    },
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    webDist: resolve(e.WEB_DIST),
  };
}
