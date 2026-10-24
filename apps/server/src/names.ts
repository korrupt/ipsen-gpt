export const NAME_MAX_LENGTH = 24;

/** Display form: NFKC, trimmed, inner whitespace collapsed. */
export function cleanName(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** Comparison key: names are unique case-insensitively. */
export function nameKey(raw: string): string {
  return cleanName(raw).toLocaleLowerCase('nb');
}

/** Returns an error message, or null if the (cleaned) name is acceptable. */
export function validateName(name: string): string | null {
  if (name.length === 0) return 'Pick a name first.';
  if (name.length > NAME_MAX_LENGTH) return `Names can be at most ${NAME_MAX_LENGTH} characters.`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(name)) {
    return 'Use letters, numbers, spaces, dots, dashes or apostrophes.';
  }
  if (!/\p{L}/u.test(name)) return 'Names need at least one letter.';
  return null;
}
