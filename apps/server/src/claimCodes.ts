import crypto from 'node:crypto';

/** No O/I/L in words and no 0/1 in digits, so codes read unambiguously off a phone. */
export const CLAIM_WORDS = [
  'BAT', 'CAT', 'FANG', 'HEX', 'WEB', 'CRYPT', 'WAND', 'BREW', 'FEAR', 'MASK',
  'RAVEN', 'REAPER', 'SCARE', 'CAPE', 'BEAST', 'DREAD', 'GRAVE', 'HAUNT', 'CHARM', 'NEWT',
] as const;
const DIGITS = '23456789';

export const CLAIM_CODE_PATTERN = /^[A-Z]+-[2-9]{3}$/;

export function generateClaimCode(): string {
  const word = CLAIM_WORDS[crypto.randomInt(CLAIM_WORDS.length)]!;
  let digits = '';
  for (let i = 0; i < 3; i++) digits += DIGITS[crypto.randomInt(DIGITS.length)];
  return `${word}-${digits}`;
}

/** Normalizes what the admin types ("bat 427", "bat427") for lookup. */
export function normalizeClaimQuery(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
