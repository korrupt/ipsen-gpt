import { describe, expect, it } from 'vitest';
import { isNearBottom, NEAR_BOTTOM_PX } from './scroll';

describe('isNearBottom', () => {
  const el = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });
  it('is true at the bottom and within the threshold', () => {
    expect(isNearBottom(el(600))).toBe(true);
    expect(isNearBottom(el(600 - NEAR_BOTTOM_PX))).toBe(true);
  });
  it('is false when scrolled up further', () => {
    expect(isNearBottom(el(600 - NEAR_BOTTOM_PX - 1))).toBe(false);
    expect(isNearBottom(el(0))).toBe(false);
  });
});
