import { createApp } from './app.js';
import { loadEnvFile, parseConfig } from './config.js';
import { loadPersona } from './prompt.js';
import { createServices } from './services.js';

const baseDir = loadEnvFile();
const config = parseConfig(process.env, baseDir);

// Fail fast on a missing persona instead of on the first chat.
loadPersona(config.chat.personaPath);

const services = createServices(config);
const app = createApp({ config, services });
const server = app.listen(config.port, config.host, () => {
  console.log(`IpsenGPT listening on http://${config.host}:${config.port}`);
  console.log(`Ollama: ${config.ollama.url} (model ${config.ollama.model})`);
  console.log(`Database: ${config.dbPath}`);
  console.log(`People: ${config.peopleDir} (${services.people.list().length} loaded)`);
  for (const e of services.people.errors) console.warn(`  people/${e}`);
  if (!services.adminAuth.enabled) console.warn('Admin is disabled: set ADMIN_PASSWORD in .env');
});

const shutdown = () => {
  server.close(() => {
    services.db.close();
    process.exit(0);
  });
  // SSE connections keep the server open; don't wait forever.
  setTimeout(() => {
    services.db.close();
    process.exit(0);
  }, 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
