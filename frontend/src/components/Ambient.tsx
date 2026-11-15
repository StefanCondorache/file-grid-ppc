'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';

const TILT = '.tilt, .tilt-soft';

/**
 * Decorative layer, no behaviour: the animated mesh backdrop behind the app (styles: globals.css `.backdrop`),
 * the cursor position for the card sheen/tilt (`--fg-px/--fg-py` on the hovered card), the point dialogs grow from
 * (`--fg-origin-x/y` on <html>), and `data-motion="paused"` on <html> while "Actualizări live" is off (WCAG 2.2.2).
 */
export function Ambient() {
  const paused = useAppStore((s) => s.livePaused);

  useEffect(() => {
    const root = document.documentElement;
    if (paused) root.dataset.motion = 'paused';
    else delete root.dataset.motion;
  }, [paused]);

  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let last: PointerEvent | null = null;

    const track = () => {
      frame = 0;
      const card = last?.target instanceof Element ? last.target.closest<HTMLElement>(TILT) : null;
      if (!card || !last) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--fg-px', ((last.clientX - r.left) / r.width).toFixed(3));
      card.style.setProperty('--fg-py', ((last.clientY - r.top) / r.height).toFixed(3));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      last = e;
      if (!frame) frame = requestAnimationFrame(track);
    };
    const setOrigin = (x: number, y: number) => {
      root.style.setProperty('--fg-origin-x', `${Math.round(x)}px`);
      root.style.setProperty('--fg-origin-y', `${Math.round(y)}px`);
    };
    const onDown = (e: PointerEvent) => setOrigin(e.clientX, e.clientY);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return;
      const r = el.getBoundingClientRect();
      setOrigin(r.left + r.width / 2, r.top + r.height / 2);
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
    document.addEventListener('keydown', onKey, { capture: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('keydown', onKey, { capture: true });
    };
  }, []);

  return (
    <div aria-hidden="true" className="backdrop">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
