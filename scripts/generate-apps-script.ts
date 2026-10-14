/**
 * Generates google/apps-script/NutexSetup.gs: ONE file you paste into Extensions -> Apps Script of a blank Google Sheet. Running it
 * builds every tab, header, formula, dropdown and protection (the no-terminal equivalent of `npm run google:create`).
 * The schema is embedded from packages/formula-specs, so code and sheet can never drift.
 *
 *   npm run apps-script:generate                     writes the file (capacity scale 0.25, time zone Asia/Kolkata)
 *   npm run apps-script:generate -- --scale=1        full capacity (must equal CAPACITY_SCALE in .env)
 *   npm run apps-script:generate -- --timezone=Asia/Dubai
 *   npm run apps-script:generate -- --check          fails if the committed file is stale
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENUMS, WORKBOOK_NAME, buildScaledSchema, formulaColumns, inputColumns, renderGrid } from '@nutex/formula-specs';
import { COLORS, WIDTH } from '../google/setup/structure';
import { ROOT } from './lib/env';

export const TEMPLATE = path.join(ROOT, 'scripts', 'apps-script', 'setup-template.gs');
export const OUT = path.join(ROOT, 'google', 'apps-script', 'NutexSetup.gs');

export function scaleFromArgs(argv = process.argv): number {
  const a = argv.find((x) => x.startsWith('--scale='));
  const s = Number(a ? a.slice(8) : 0.25);
  if (!(s > 0 && s <= 1)) throw new Error('scale must be in (0, 1]');
  return s;
}

export function generate(scale: number, timezone = 'Asia/Kolkata'): string {
  const idx = buildScaledSchema(scale);
  const tabs = idx.tabs.map((t) => {
    const grid = t.fixedRows ? renderGrid(idx, t) : renderGrid(idx, t, { rows: 1 });
    return {
      name: t.name, group: t.group, purpose: t.purpose, rows: idx.rowsFor(t), key: t.keyColumn, service: t.protection === 'SERVICE_ONLY', append: !!t.appendOnly,
      inputs: inputColumns(t).length, formulas: formulaColumns(t).length,
      cols: t.columns.map((c, i) => ({
        n: c.name, t: c.type, ...(c.kind === 'formula' ? { k: 1, f: String(grid[1]?.[i] ?? '') } : {}), ...(c.enum ? { e: c.enum } : {}),
        ...(c.ref ? { r: idx.range(c.ref.split('.')[0], c.ref.split('.')[1]) } : {}), ...(c.note ? { o: c.note } : {}),
      })),
      ...(t.fixedRows ? { fixed: grid.slice(1, 1 + t.fixedRows.length) } : {}),
    };
  });
  const tabLines = `[\n${tabs.map((t) => `  ${JSON.stringify(t)}`).join(',\n')}\n]`;
  return readFileSync(TEMPLATE, 'utf8')
    .replace('__TAB_COUNT__', String(tabs.length)).replace('__TIMEZONE__', timezone).replace('__WORKBOOK_NAME__', WORKBOOK_NAME.split("'").join('\\u0027'))
    .replace('__SCALE__', String(scale)).replace('__COLORS__', JSON.stringify(COLORS)).replace('__WIDTHS__', JSON.stringify(WIDTH))
    .replace('__ENUMS__', JSON.stringify(ENUMS)).replace('__TABS__', tabLines);
}

if (process.argv[1] && /generate-apps-script/.test(process.argv[1])) {
  const scale = scaleFromArgs();
  const tz = process.argv.find((x) => x.startsWith('--timezone='));
  const src = generate(scale, tz ? tz.slice(11) : 'Asia/Kolkata');
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== src) { console.error('✖ google/apps-script/NutexSetup.gs is stale. Run npm run apps-script:generate'); process.exit(1); }
    console.log('✔ NutexSetup.gs is up to date');
  } else {
    writeFileSync(OUT, src, 'utf8');
    console.log(`wrote google/apps-script/NutexSetup.gs (${Math.round(src.length / 1024)} KB, ${src.split('\n').length} lines, capacity scale ${scale})`);
  }
}
