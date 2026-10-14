'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Pointer effects for the whole app, using one delegated listener (no per-card handlers):
 *  - --mx / --my on <html>: where the pointer is (-1..1), drives the 3D login scene
 *  - --px / --py on the card under the pointer: the light that follows it
 *  - a gentle 3D tilt on small cards (never on tables or long lists)
 * Nothing runs for people who asked for reduced motion, and the tilt only runs with a real mouse (not on touch screens).
 */
export function FxProvider() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const root = document.documentElement;
    let frame = 0;
    let last: PointerEvent | null = null;
    let tilted: HTMLElement | null = null;

    const reset = (el: HTMLElement | null) => { if (!el) return; el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); el.classList.remove('tilting'); };

    const apply = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      root.style.setProperty('--mx', ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      root.style.setProperty('--my', ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
      const card = (e.target as Element | null)?.closest?.('.card') as HTMLElement | null;
      if (card !== tilted) { reset(tilted); tilted = null; }
      if (!card) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--px', `${(x * 100).toFixed(1)}%`);
      card.style.setProperty('--py', `${(y * 100).toFixed(1)}%`);
      if (fine && r.height < 380 && r.width < 900) {
        card.style.setProperty('--rx', `${((y - 0.5) * -7).toFixed(2)}deg`);
        card.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`);
        card.classList.add('tilting');
        tilted = card;
      }
    };
    const onMove = (e: PointerEvent) => { last = e; if (!frame) frame = requestAnimationFrame(apply); };
    const onLeave = () => { reset(tilted); tilted = null; };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}

/** a number that counts up to its value (and re-counts from the old value when it changes) */
export function CountUp({ value, format = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 }), duration = 900 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { from.current = value; setShown(value); return; }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      const v = origin + (value - origin) * eased;
      from.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span aria-label={format(value)}>{format(shown)}</span>;
}
