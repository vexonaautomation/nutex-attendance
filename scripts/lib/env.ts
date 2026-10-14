import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..');

/** minimal .env loader (no dependency): KEY=VALUE, # comments, optional quotes. Real environment variables win. */
export function loadDotEnv(file = path.join(ROOT, '.env')): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function env(): Record<string, string | undefined> {
  return { ...loadDotEnv(), ...process.env };
}

export const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
