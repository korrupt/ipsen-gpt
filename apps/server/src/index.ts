import { createApp } from './app.js';
import { loadEnvFile, parseConfig } from './config.js';
import { loadPersona } from './prompt.js';

const baseDir = loadEnvFile();
const config = parseConfig(process.env, baseDir);

// Fail fast on a missing persona instead of on the first chat.
loadPersona(config.chat.personaPath);

const app = createApp({ config });
const server = app.listen(config.port, config.host, () => {
  console.log(`IpsenGPT listening on http://${config.host}:${config.port}`);
  console.log(`Ollama: ${config.ollama.url} (model ${config.ollama.model})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // SSE connections keep the server open; don't wait forever.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
