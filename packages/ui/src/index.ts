/**
 * NUTEX design tokens shared by the web app, generated documents (payslip PDF) and any future client.
 * The CSS in apps/web/app/globals.css mirrors these values; keep the two in sync.
 */
export const BRAND = {
  name: 'NUTEX',
  tagline: 'Smart Attendance',
  /** the mark is an SVG (apps/web/components/Brand.tsx): one artwork for both themes */
  mark: '/brand/nutex-mark.svg',
} as const;

export const THEME = {
  dark: { bg: '#050816', surface: '#0d1330', surface2: '#151c40', border: '#2a3560', text: '#eaf0ff', textDim: '#9aa9cc', brand: '#5b95ff', brandInk: '#04112e', accent: '#ff8a3d', danger: '#ff6b81', warn: '#ffc857', info: '#6ea8ff' },
  light: { bg: '#eef3ff', surface: '#ffffff', surface2: '#e6edff', border: '#c6d1ee', text: '#0f1a3a', textDim: '#51608a', brand: '#2563eb', brandInk: '#ffffff', accent: '#ea580c', danger: '#c62f3f', warn: '#a8660a', info: '#2563c9' },
} as const;

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

/** WCAG relative luminance contrast ratio between two #rrggbb colours */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
