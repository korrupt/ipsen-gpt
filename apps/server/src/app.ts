import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Config } from './config.js';
import { loadPersona } from './prompt.js';
import { chatRouter } from './routes/chat.js';

export interface AppDeps {
  config: Config;
  getPersona?: () => string;
  log?: (msg: string, err?: unknown) => void;
}

const defaultLog = (msg: string, err?: unknown) => {
  console.error(`[${new Date().toISOString()}] ${msg}`, err ?? '');
};

export function createApp({ config, getPersona, log = defaultLog }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Nginx on the same host; trust only the loopback proxy for req.ip.
  app.set('trust proxy', 'loopback');

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(
    chatRouter({
      config,
      // Re-read on every request so persona edits apply without a restart.
      getPersona: getPersona ?? (() => loadPersona(config.chat.personaPath)),
      log,
    }),
  );
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  api.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) log('Unhandled API error', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : 'Bad request' });
  });
  app.use('/api', api);

  // Built frontend (production). In dev, Vite serves it and proxies /api here.
  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.webDist, {
        index: false,
        setHeaders(res, filePath) {
          // Vite's hashed bundles never change; everything else (portrait, favicon) must revalidate
          // so swapping a theme asset shows up immediately.
          const hashed = filePath.startsWith(path.join(config.webDist, 'assets') + path.sep);
          res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  return app;
}
