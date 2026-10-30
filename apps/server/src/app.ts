import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Config } from './config.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';
import { eventsRouter } from './routes/events.js';
import { photosRouter } from './routes/photos.js';
import { secretRouter } from './routes/secret.js';
import { sessionRouter } from './routes/session.js';
import type { Session } from './sessions.js';
import type { Services } from './services.js';

export interface AppDeps {
  config: Config;
  services: Services;
  /** The persona prompt for a session and a key that changes with the character (tests can override it). */
  getPersona?: (session: Session) => { prompt: string; key: string };
  log?: (msg: string, err?: unknown) => void;
}

export function createApp({ config, services, getPersona, log = services.log }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Nginx on the same host; trust only the loopback proxy for req.ip.
  app.set('trust proxy', 'loopback');

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(sessionRouter(config, services));
  api.use(
    chatRouter({
      config,
      services,
      // Re-read on every request so persona edits and switches apply at once.
      getPersona:
        getPersona ??
        ((session) => {
          // A claimed person's persona (custom or listed) applies unless the session has its own pick.
          const person = session.state === 'claimed' && session.personSlug ? services.people.get(session.personSlug) : undefined;
          return services.personas.promptFor(session, person ?? null);
        }),
      log,
    }),
  );
  api.use(photosRouter(config, services));
  api.use(secretRouter(config, services));
  api.use(eventsRouter(config, services));
  api.use('/admin', adminRouter(config, services));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  api.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) log('Unhandled API error', err);
    const error = status >= 500 ? 'Internal error' : status === 413 ? 'That file is too big.' : 'Bad request';
    res.status(status).json({ error });
  });
  app.use('/api', api);

  // Built frontend (production). In dev, Vite serves it and proxies /api here.
  const indexHtml = path.join(config.webDist, 'index.html');
  const adminHtml = path.join(config.webDist, 'admin', 'index.html');
  if (fs.existsSync(indexHtml)) {
    const sendPage = (file: string) => (_req: express.Request, res: express.Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(file);
    };
    // Non-strict routing would also match '/admin/' here, so check the exact path to avoid a loop.
    app.get('/admin', (req, res, next) => (req.path === '/admin' ? res.redirect(301, '/admin/') : next()));
    app.use(
      express.static(config.webDist, {
        index: false,
        redirect: false,
        setHeaders(res, filePath) {
          // Vite's hashed bundles never change; everything else (portrait, favicon) must revalidate
          // so swapping a theme asset shows up immediately.
          const hashed = filePath.startsWith(path.join(config.webDist, 'assets') + path.sep);
          res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    if (fs.existsSync(adminHtml)) app.get('/admin/{*splat}', sendPage(adminHtml));
    app.get('/{*splat}', sendPage(indexHtml));
  }

  return app;
}
