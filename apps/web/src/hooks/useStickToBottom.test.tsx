import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useStickToBottom } from './useStickToBottom';

/** jsdom has no layout, so fake a 1000px tall scroller in a 400px viewport. */
function Scroller({ trigger, forceKey }: { trigger: number; forceKey: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onScroll } = useStickToBottom(ref, trigger, forceKey);
  return (
    <div
      data-testid="s"
      ref={(el) => {
        ref.current = el;
        if (el) {
          Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
          Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
        }
      }}
      onScroll={onScroll}
    />
  );
}

describe('useStickToBottom', () => {
  it('follows new content while at the bottom, not after the user scrolls up, and re-sticks on forceKey', () => {
    const { getByTestId, rerender } = render(<Scroller trigger={0} forceKey={0} />);
    const el = getByTestId('s');
    expect(el.scrollTop).toBe(1000);

    // User scrolls up to read; new tokens must not move them.
    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
    });
    rerender(<Scroller trigger={1} forceKey={0} />);
    expect(el.scrollTop).toBe(100);

    // User sends a message: jump to the bottom.
    rerender(<Scroller trigger={2} forceKey={1} />);
    expect(el.scrollTop).toBe(1000);
  });
});
