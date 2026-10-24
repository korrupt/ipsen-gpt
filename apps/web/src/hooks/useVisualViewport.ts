import { useEffect } from 'react';

/**
 * Keeps --app-height / --app-offset-top in sync with the visual viewport, so
 * when the on-screen keyboard opens (iOS Safari doesn't resize the layout
 * viewport) the composer stays visible above it.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--app-height', `${vv.height}px`);
        root.style.setProperty('--app-offset-top', `${vv.offsetTop}px`);
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-offset-top');
    };
  }, []);
}
