/**
 * Generates google/sheet-schema/*.json from the TypeScript schema definitions (packages/formula-specs).
 * The TypeScript is the single source of truth; these JSON files are the reviewable, diff-able artefacts.
 *
 *   npm run schema:generate            writes the files (full-capacity reference build)
 *   npm run schema:generate -- --check fails if the committed files are stale (used by verify:headers / CI)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildScaledSchema, formulasJson, headersJson, protectionsJson, validationsJson, workbookSchemaJson } from '@nutex/formula-specs';
import { ROOT } from './lib/env';

export const OUT_DIR = path.join(ROOT, 'google', 'sheet-schema');

export function artefacts(): Record<string, unknown> {
  const idx = buildScaledSchema(1);
  return {
    'workbook-schema.json': workbookSchemaJson(idx), 'headers.json': headersJson(idx), 'formulas.json': formulasJson(idx),
    'validations.json': validationsJson(idx), 'protections.json': protectionsJson(idx),
  };
}

export function stale(): string[] {
  return Object.entries(artefacts()).filter(([f, v]) => {
    const p = path.join(OUT_DIR, f);
    return !existsSync(p) || readFileSync(p, 'utf8') !== `${JSON.stringify(v, null, 2)}\n`;
  }).map(([f]) => f);
}

if (process.argv[1] && /generate-schema/.test(process.argv[1])) {
  if (process.argv.includes('--check')) {
    const s = stale();
    if (s.length) { console.error(`✖ stale schema artefacts: ${s.join(', ')}. Run npm run schema:generate`); process.exit(1); }
    console.log('✔ google/sheet-schema/*.json are up to date');
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [f, v] of Object.entries(artefacts())) {
      writeFileSync(path.join(OUT_DIR, f), `${JSON.stringify(v, null, 2)}\n`, 'utf8');
      console.log(`wrote google/sheet-schema/${f}`);
    }
  }
}
