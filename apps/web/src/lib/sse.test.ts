import { describe, expect, it } from 'vitest';
import { SseParser, type SseMessage } from './sse';

function parse(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = new SseParser((m) => out.push(m));
  chunks.forEach((c) => p.push(c));
  return out;
}

const STREAM =
  ': connected\n\nevent: token\ndata: {"text":"Hel"}\n\n: ping\n\nevent: token\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n';

describe('SseParser', () => {
  it('parses events and skips comments', () => {
    expect(parse([STREAM])).toEqual([
      { event: 'token', data: '{"text":"Hel"}' },
      { event: 'token', data: '{"text":"lo"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('gives the same result for every possible split point', () => {
    const whole = parse([STREAM]);
    for (let i = 1; i < STREAM.length; i++) {
      expect(parse([STREAM.slice(0, i), STREAM.slice(i)])).toEqual(whole);
    }
  });

  it('handles one character at a time and CRLF line endings', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    expect(parse(crlf.split(''))).toEqual(parse([STREAM]));
  });

  it('joins multi-line data and defaults the event name', () => {
    expect(parse(['data: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('does not emit an incomplete event', () => {
    expect(parse(['event: token\ndata: {"text":"x"}\n'])).toEqual([]);
  });
});
