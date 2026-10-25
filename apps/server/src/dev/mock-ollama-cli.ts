import { startMockOllama, type MockVerdict } from './mock-ollama.js';

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11436);
const tokenDelayMs = Number(process.env.MOCK_OLLAMA_DELAY_MS ?? 60);

// Fixed reply text, so tests can tell two mocks apart.
const text = process.env.MOCK_OLLAMA_REPLY;

// Photo verdicts: pass | fail | bad | cycle (the first photo fails, the next passes, ...).
const verdict = (process.env.MOCK_OLLAMA_VERDICT ?? 'cycle') as MockVerdict;

const mock = await startMockOllama({ port, tokenDelayMs, mode: { kind: 'reply', text }, verdict });
console.log(`Mock Ollama listening on ${mock.url}`);
