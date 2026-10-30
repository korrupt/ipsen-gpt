import { createApp } from './app.js';
import { loadEnvFile, parseConfig } from './config.js';
import { createServices } from './services.js';

const baseDir = loadEnvFile();
const config = parseConfig(process.env, baseDir);

const services = createServices(config);
// Fail fast on missing personas instead of on the first chat.
services.personas.effective(null);
const app = createApp({ config, services });
const server = app.listen(config.port, config.host, () => {
  console.log(`SadGPT listening on http://${config.host}:${config.port}`);
  console.log(`Ollama: ${config.ollama.url} (model ${config.ollama.model})`);
  console.log(`Database: ${config.dbPath}`);
  const personas = services.personas.load();
  console.log(`Personas: ${config.chat.personasDir} (${personas.personas.length} loaded, active: ${services.personas.activeId()})`);
  for (const e of personas.errors) console.warn(`  personas/${e}`);
  console.log(`People: ${config.peopleDir} (${services.people.list().length} loaded)`);
  for (const e of services.people.errors) console.warn(`  people/${e}`);
  const gates = services.gateDefs();
  console.log(`Gates: ${config.gatesPath} (${gates.defs.length} loaded)`);
  for (const e of gates.errors) console.warn(`  ${e}`);
  console.log(`Photos: ${config.photos.dir}`);
  if (!services.adminAuth.enabled) console.warn('Admin is disabled: set ADMIN_PASSWORD in .env');
});

// Timed global gates and deadlines.
const ticker = setInterval(() => {
  try {
    services.tick();
  } catch (err) {
    services.log('Gate tick failed', err);
  }
}, 5000);

// Is the PC reachable? Guests see the answer live, and chat closes while it isn't.
const checkModel = () => void services.llm.check();
checkModel();
const modelChecker = setInterval(checkModel, config.ollama.checkIntervalMs);

const shutdown = () => {
  clearInterval(ticker);
  clearInterval(modelChecker);
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
