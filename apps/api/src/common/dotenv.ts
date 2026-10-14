import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** parse KEY=VALUE lines (# comments, optional quotes) */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Loads the project `.env` (repo root, or the current folder) into process.env. Variables that are already set win, so a
 * platform's own environment (Docker, systemd, a secret manager) always overrides the file.
 */
export function loadProjectEnv(cwd = process.cwd()): string | undefined {
  for (const file of [path.resolve(cwd, '../../.env'), path.resolve(cwd, '.env')]) {
    if (!existsSync(file)) continue;
    for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) if (process.env[k] === undefined) process.env[k] = v;
    return file;
  }
  return undefined;
}
