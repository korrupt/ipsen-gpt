import { describe, expect, it } from 'vitest';
import { buildMessages, trimHistory, type HistoryMessage } from '../src/prompt.js';

const turns = (n: number): HistoryMessage[] =>
  Array.from({ length: n }, (_, i) => [
    { role: 'user' as const, content: `u${i}` },
    { role: 'assistant' as const, content: `a${i}` },
  ]).flat();

describe('trimHistory', () => {
  it('keeps only the last N turns', () => {
    const out = trimHistory(turns(12), 8);
    expect(out).toHaveLength(16);
    expect(out[0]).toEqual({ role: 'user', content: 'u4' });
    expect(out.at(-1)).toEqual({ role: 'assistant', content: 'a11' });
  });

  it('never starts on an assistant message', () => {
    const history: HistoryMessage[] = [{ role: 'assistant', content: 'hi' }, ...turns(1)];
    expect(trimHistory(history, 8)[0]?.role).toBe('user');
  });

  it('returns nothing for 0 turns', () => {
    expect(trimHistory(turns(3), 0)).toEqual([]);
  });
});

describe('buildMessages', () => {
  it('puts persona + extra sections in one system message, then history, then the user message', () => {
    const msgs = buildMessages({
      persona: 'PERSONA',
      extraSystem: ['PERSON INFO', 'CURSE'],
      history: turns(2),
      historyTurns: 1,
      userMessage: 'hello',
    });
    expect(msgs[0]).toEqual({ role: 'system', content: 'PERSONA\n\nPERSON INFO\n\nCURSE' });
    expect(msgs.slice(1).map((m) => m.content)).toEqual(['u1', 'a1', 'hello']);
    expect(msgs.at(-1)?.role).toBe('user');
  });
});
