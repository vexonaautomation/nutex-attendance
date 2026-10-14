/**
 * Formula verification. Loads the exact workbook grid (headers + pre-filled formulas) into a spreadsheet engine, seeds it,
 * and checks:
 *   - every formula parses; only functions available in BOTH Google Sheets and the engine are used
 *   - no unresolved macro tokens leak into a formula
 *   - zero #REF! / #VALUE! / #N/A / #DIV/0! / #NAME? / #CYCLE! on the empty and on the seeded workbook
 *   - master keys are unique
 * This is the "formula health check" that also runs inside the sheet as DASHBOARD_DATA.h_* metrics.
 */
import { HyperFormula } from 'hyperformula';
import { buildTestSchema, formulaColumns, renderGrid } from '@nutex/formula-specs';
import { EmulatorGateway, SheetRepository } from '@nutex/sheet-connector';
import { applySeed } from '../google/setup/apply-seed';

/** functions that exist in Google Sheets AND HyperFormula; anything else must be added here consciously */
const ALLOWED = new Set(['IF', 'IFERROR', 'AND', 'OR', 'INDEX', 'MATCH', 'MID', 'WEEKDAY', 'COUNTIFS', 'SUMIFS', 'MINIFS', 'MAXIFS', 'SUM', 'SUMPRODUCT', 'COUNTA', 'ROWS', 'ROUND', 'ROUNDUP', 'INT', 'MAX', 'MIN', 'N', 'ISNUMBER', 'ISBLANK', 'ISERROR', 'SEARCH', 'SUBSTITUTE', 'TRIM', 'DATE', 'YEAR', 'MONTH', 'NETWORKDAYS.INTL', 'PMT']);
const errRe = /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|CYCLE!|ERROR!|SPILL!)/;

const idx = buildTestSchema(60);
const problems: string[] = [];
const fnUse = new Map<string, number>();
let formulaCount = 0;

const parser = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
for (const t of idx.tabs) {
  const grid = renderGrid(idx, t, { rows: 2 });
  for (const row of grid.slice(1)) {
    for (const cell of row) {
      if (typeof cell !== 'string' || !cell.startsWith('=')) continue;
      formulaCount++;
      if (/@[a-z_]|\$(CFG|RULE|LKD?)\(|\[[A-Z_]+\.[a-z0-9_]+\]|\{FRANGE/.test(cell.replace(/"[^"]*"/g, ''))) problems.push(`${t.name}: unresolved token in ${cell.slice(0, 90)}`);
      for (const m of cell.replace(/"[^"]*"/g, '').matchAll(/([A-Z][A-Z0-9.]*)\(/g)) {
        fnUse.set(m[1], (fnUse.get(m[1]) ?? 0) + 1);
        if (!ALLOWED.has(m[1])) problems.push(`${t.name}: function ${m[1]} is not in the Sheets+engine allowlist`);
      }
      if (!parser.validateFormula(cell)) problems.push(`${t.name}: unparsable formula ${cell.slice(0, 90)}`);
    }
  }
}

async function scanErrors(gw: EmulatorGateway, label: string, skip: string[] = []) {
  let n = 0;
  const samples: string[] = [];
  for (const t of idx.tabs) {
    if ((!formulaColumns(t).length && !t.fixedRows) || skip.includes(t.name)) continue;
    const rows = idx.rowsFor(t) + 1;
    const width = t.columns.length;
    const cols = (i: number) => { let s = ''; let x = i + 1; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };
    const [full] = await gw.readRanges([`${t.name}!A2:${cols(width - 1)}${rows}`]);
    full.forEach((line, r) => line.forEach((v, c) => { if (typeof v === 'string' && errRe.test(v)) { n++; if (samples.length < 8) samples.push(`${t.name}!${cols(c)}${r + 2} = ${v} (${t.columns[c].name})`); } }));
  }
  if (n) problems.push(`${label}: ${n} formula error cell(s): ${samples.join('; ')}`);
  return n;
}

async function main() {
  const gw = new EmulatorGateway(idx);
  // DASHBOARD_DATA reads SYSTEM_CONFIG, so it is only meaningful once config is seeded
  const empty = await scanErrors(gw, 'empty workbook', ['DASHBOARD_DATA']);
  const repo = new SheetRepository(gw, idx, { cacheTtlMs: 0 });
  await applySeed(repo, idx, {});
  const seeded = await scanErrors(gw, 'seeded workbook');

  for (const tab of ['EMPLOYEES', 'SHIFT_MASTER', 'LEAVE_TYPES', 'SALARY_COMPONENTS', 'STATUTORY_RULES', 'LEAVE_POLICIES']) {
    const t = idx.tab(tab);
    const keys = (await repo.readAll(tab)).map((r) => String(r[t.keyColumn]));
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dup.length) problems.push(`${tab}: duplicate keys ${dup.join(', ')}`);
  }
  const dash = await repo.readAll('DASHBOARD_DATA');
  const bad = dash.filter((r) => String(r.metric_key).startsWith('h_errors') && Number(r.value) !== 0);
  if (bad.length) problems.push(`dashboard health metrics report errors: ${bad.map((r) => r.metric_key).join(', ')}`);

  console.log(`${formulaCount} distinct formulas checked across ${idx.tabs.length} tabs; functions used: ${[...fnUse.keys()].sort().join(', ')}`);
  console.log(`error cells: empty=${empty}, seeded=${seeded}; dashboard health metrics: ${dash.filter((r) => String(r.metric_key).startsWith('h_')).length}`);
  if (problems.length) { console.error(`\n✖ ${problems.length} formula problem(s):\n - ${problems.join('\n - ')}`); process.exit(1); }
  console.log('✔ formulas OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
