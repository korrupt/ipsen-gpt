import { startMockOllama } from './mock-ollama.js';

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11436);
const tokenDelayMs = Number(process.env.MOCK_OLLAMA_DELAY_MS ?? 60);

// Fixed reply text, so tests can tell two mocks apart.
const text = process.env.MOCK_OLLAMA_REPLY;

const mock = await startMockOllama({ port, tokenDelayMs, mode: { kind: 'reply', text } });
console.log(`Mock Ollama listening on ${mock.url}`);
