import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isNearBottom } from '../lib/scroll';

/**
 * Auto-scrolls `ref` to the bottom when `trigger` changes, but only if the
 * user was already near the bottom (so reading older messages isn't hijacked).
 * A change in `forceKey` (e.g. the user sent a message) always re-sticks.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, trigger: unknown, forceKey: unknown) {
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = isNearBottom(el);
    setAtBottom(stuck.current);
  }, [ref]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = ref.current;
      if (!el) return;
      stuck.current = true;
      setAtBottom(true);
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [ref],
  );

  // Must run before the trigger effect below.
  useLayoutEffect(() => {
    stuck.current = true;
    setAtBottom(true);
  }, [forceKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [ref, trigger]);

  return { onScroll, scrollToBottom, atBottom };
}
