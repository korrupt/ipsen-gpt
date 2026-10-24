import { startMockOllama } from './mock-ollama.js';

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11436);
const tokenDelayMs = Number(process.env.MOCK_OLLAMA_DELAY_MS ?? 60);

const mock = await startMockOllama({ port, tokenDelayMs });
console.log(`Mock Ollama listening on ${mock.url}`);
