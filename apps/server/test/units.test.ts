import { describe, expect, it } from 'vitest';
import { CLAIM_CODE_PATTERN, CLAIM_WORDS, generateClaimCode, normalizeClaimQuery } from '../src/claimCodes.js';
import { cleanName, nameKey, validateName } from '../src/names.js';
import { RateLimiter } from '../src/rateLimit.js';

describe('names', () => {
  it('cleans whitespace and compares case-insensitively', () => {
    expect(cleanName('  Ola   Nordmann ')).toBe('Ola Nordmann');
    expect(nameKey('ÅSE')).toBe(nameKey('åse'));
    expect(nameKey(' Ola  NORDMANN')).toBe(nameKey('ola nordmann'));
  });

  it.each([
    ['Ola', null],
    ['Åse-Marie', null],
    ["O'Brien Jr.", null],
    ['R2D2', null],
    ['', /Pick a name/],
    ['x'.repeat(25), /at most 24/],
    ['<script>', /Use letters/],
    ['-dash', /Use letters/],
    ['1234', /at least one letter/],
    ['Ola\nNordmann', /Use letters/],
  ])('validateName(%j)', (name, expected) => {
    const err = validateName(name);
    if (expected === null) expect(err).toBeNull();
    else expect(err).toMatch(expected);
  });
});

describe('claim codes', () => {
  it('look like BAT-427 with no ambiguous characters', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateClaimCode();
      expect(code).toMatch(CLAIM_CODE_PATTERN);
      expect(code).not.toMatch(/[OIL01]/);
    }
  });

  it('use a word list without O, I or L', () => {
    for (const w of CLAIM_WORDS) expect(w).not.toMatch(/[OIL]/);
  });

  it('normalizes loose admin input', () => {
    expect(normalizeClaimQuery(' bat 427')).toBe('BAT427');
    expect(normalizeClaimQuery('Bat-427')).toBe('BAT427');
  });
});

describe('RateLimiter', () => {
  it('allows `count` hits per sliding window and reports the wait', () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    const rule = { count: 2, windowMs: 1000 };
    expect(rl.hit('k', rule)).toBe(0);
    now = 400;
    expect(rl.hit('k', rule)).toBe(0);
    now = 500;
    expect(rl.hit('k', rule)).toBe(500); // first hit expires at 1000
    expect(rl.hit('other', rule)).toBe(0);
    now = 1001;
    expect(rl.hit('k', rule)).toBe(0);
  });

  it('reset clears a key', () => {
    const rl = new RateLimiter(() => 0);
    const rule = { count: 1, windowMs: 1000 };
    rl.hit('k', rule);
    expect(rl.hit('k', rule)).toBeGreaterThan(0);
    rl.reset('k');
    expect(rl.hit('k', rule)).toBe(0);
  });
});
