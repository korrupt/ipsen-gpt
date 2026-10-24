/** Distance from the bottom (px) within which we keep auto-scrolling. */
export const NEAR_BOTTOM_PX = 80;

export function isNearBottom(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}
