import fs from 'node:fs';
import type { ChatMessage } from './ollama.js';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PromptInput {
  persona: string;
  /** Extra system sections appended after the persona (person info, curse modifiers, ...). */
  extraSystem?: string[];
  history: HistoryMessage[];
  /** How many previous user+assistant turns to keep. */
  historyTurns: number;
  userMessage: string;
}

export function loadPersona(personaPath: string): string {
  const text = fs.readFileSync(personaPath, 'utf8').trim();
  if (!text) throw new Error(`Persona file is empty: ${personaPath}`);
  return text;
}

/** Keeps the last `turns` turns (a turn = one user + one assistant message). */
export function trimHistory(history: HistoryMessage[], turns: number): HistoryMessage[] {
  if (turns <= 0) return [];
  const trimmed = history.slice(-turns * 2);
  // Never start the window on an assistant message; the model expects user first.
  while (trimmed[0]?.role === 'assistant') trimmed.shift();
  return trimmed;
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const system = [input.persona, ...(input.extraSystem ?? [])].join('\n\n');
  return [
    { role: 'system', content: system },
    ...trimHistory(input.history, input.historyTurns),
    { role: 'user', content: input.userMessage },
  ];
}
