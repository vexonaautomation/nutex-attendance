/**
 * Verifies that the live workbook matches the schema in code: tabs, headers, formulas, validations, protections, named
 * ranges, capacity, config, Drive folders and formula health.
 *
 *   npm run google:verify              against the real workbook (GOOGLE_SPREADSHEET_ID)
 *   npm run google:verify -- --offline runs the same header/formula/config/health checks against the local emulator
 */
import { google } from 'googleapis';
import { SCHEMA_VERSION, TAB_ORDER, buildScaledSchema, buildTestSchema, colLetter, formulasJson, headersJson, renderGrid, validationsJson, protectionsJson, type SchemaIndex } from '@nutex/formula-specs';
import { EmulatorGateway, GoogleSheetsGateway, SheetRepository, createGoogleAuth, type SheetsGateway } from '@nutex/sheet-connector';
import { env, fail } from '../../scripts/lib/env';
import { applySeed } from './apply-seed';

export interface Check { area: string; name: string; status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP'; detail?: string }

const has = (checks: Check[]) => (area: string, name: string, ok: boolean, detail?: string, level: 'FAIL' | 'WARN' = 'FAIL') => checks.push({ area, name, status: ok ? 'PASS' : level, detail: ok ? undefined : detail });

/** checks that work through any SheetsGateway (real Google or emulator) */
export async function commonChecks(gw: SheetsGateway, idx: SchemaIndex, checks: Check[]): Promise<void> {
  const check = has(checks);
  const headers = headersJson(idx);
  const ranges = idx.tabs.map((t) => `${t.name}!A1:${colLetter(t.columns.length - 1)}1`);
  let headerRows: Array<Array<Array<string | number | boolean | null>>>;
  try { headerRows = await gw.readRanges(ranges); } catch (e) { check('tabs', 'all tabs readable', false, e instanceof Error ? e.message : String(e)); return; }
  check('tabs', `all ${idx.tabs.length} tabs readable`, true);
  idx.tabs.forEach((t, i) => {
    const actual = headerRows[i][0].map((v) => String(v ?? ''));
    check('headers', t.name, JSON.stringify(actual) === JSON.stringify(headers[t.name]), `expected ${headers[t.name].length} columns, sheet row 1 differs (first diff: ${actual.findIndex((v, k) => v !== headers[t.name][k])})`);
  });

  // formulas in row 2 of every formula block (FORMULA render is Google-only; emulator exposes them through getCell)
  if (gw.kind === 'google') {
    const g = gw as GoogleSheetsGateway;
    const fr = idx.tabs.filter((t) => t.columns.some((c) => c.kind === 'formula'));
    const res = await g.sheets.spreadsheets.values.batchGet({
      spreadsheetId: (g as unknown as { spreadsheetId: string }).spreadsheetId, valueRenderOption: 'FORMULA',
      ranges: fr.map((t) => `${t.name}!A2:${colLetter(t.columns.length - 1)}2`),
    });
    fr.forEach((t, i) => {
      const grid = renderGrid(idx, t, { rows: 1 });
      const expected = grid[1];
      const actual = (res.data.valueRanges?.[i]?.values?.[0] ?? []) as unknown[];
      const bad: string[] = [];
      t.columns.forEach((c, ci) => { if (c.kind === 'formula' && String(actual[ci] ?? '') !== String(expected[ci] ?? '')) bad.push(c.name); });
      check('formulas', t.name, bad.length === 0, `formula drift in: ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? '…' : ''}`);
    });
  } else {
    checks.push({ area: 'formulas', name: 'row-2 formula text', status: 'SKIP', detail: 'emulator builds them from the same generator' });
  }

  // config
  const cfgRows = (await gw.readRanges([`SYSTEM_CONFIG!A2:B${Math.min(idx.rowsFor(idx.tab('SYSTEM_CONFIG')) + 1, 200)}`]))[0];
  const cfg = new Map(cfgRows.filter((r) => r[0]).map((r) => [String(r[0]), r[1]]));
  if (cfg.size === 0) checks.push({ area: 'config', name: 'SYSTEM_CONFIG', status: 'WARN', detail: 'empty: run npm run google:init' });
  else {
    check('config', 'schema version', String(cfg.get('SCHEMA_VERSION')) === SCHEMA_VERSION, `sheet=${cfg.get('SCHEMA_VERSION')} code=${SCHEMA_VERSION}`);
    for (const k of ['DRIVE_DOCS_FOLDER_ID', 'DRIVE_PAYSLIP_FOLDER_ID']) check('config', k, !!cfg.get(k) && String(cfg.get(k)).length > 3, 'not set (folders missing?)', 'WARN');
  }

  // formula health metrics (DASHBOARD_DATA is itself formula driven)
  const dash = (await gw.readRanges([`DASHBOARD_DATA!A2:D${Math.min(idx.rowsFor(idx.tab('DASHBOARD_DATA')) + 1, 100)}`]))[0];
  const health = dash.filter((r) => String(r[0] ?? '').startsWith('h_'));
  const bad = health.filter((r) => typeof r[3] === 'string' || (typeof r[3] === 'number' && r[3] > 0 && !String(r[0]).startsWith('h_missing')));
  check('health', `${health.length} formula health metrics`, health.length > 0 && bad.length === 0, bad.map((r) => `${r[0]}=${r[3]}`).join(', '), 'WARN');
  const cap = dash.filter((r) => String(r[0]).startsWith('cap_'));
  const warnPct = Number(cfg.get('CAPACITY_WARN_PCT') ?? 0.8);
  for (const r of cap) check('capacity', String(r[0]), !(typeof r[3] === 'number' && r[3] >= warnPct), `${Math.round(Number(r[3]) * 100)}% used: extend capacity or archive closed periods`, 'WARN');
}

/** Google-only structural checks: sheet properties, protections, validations, named ranges */
export async function googleStructureChecks(g: GoogleSheetsGateway, spreadsheetId: string, idx: SchemaIndex, checks: Check[]): Promise<void> {
  const check = has(checks);
  const res = await g.sheets.spreadsheets.get({
    spreadsheetId, ranges: idx.tabs.map((t) => `${t.name}!A2:${colLetter(t.columns.length - 1)}2`), includeGridData: true,
    fields: 'namedRanges(name),sheets(properties(title,gridProperties),data(rowData(values(dataValidation(condition(type))))))',
  });
  // protectedRanges come back filtered to the requested ranges (row 2 only), which hides header-row locks: ask for them separately
  const prot = await g.sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title),protectedRanges(description,warningOnly))' });
  const protByTitle = new Map((prot.data.sheets ?? []).map((x) => [x.properties?.title ?? '', x.protectedRanges ?? []]));
  const sheets = res.data.sheets ?? [];
  const titles = sheets.map((s) => s.properties?.title);
  check('tabs', 'order and names', JSON.stringify(titles) === JSON.stringify([...TAB_ORDER]), `sheet has: ${titles.join(', ')}`);
  const named = new Set((res.data.namedRanges ?? []).map((n) => n.name));
  const vals = validationsJson(idx);
  idx.tabs.forEach((t, i) => {
    const s = sheets.find((x) => x.properties?.title === t.name);
    if (!s) return check('structure', t.name, false, 'tab missing');
    const gp = s.properties?.gridProperties;
    check('capacity', `${t.name} rows`, gp?.rowCount === idx.rowsFor(t) + 1, `rowCount=${gp?.rowCount} expected=${idx.rowsFor(t) + 1} (CAPACITY_SCALE mismatch?)`);
    check('capacity', `${t.name} frozen header`, gp?.frozenRowCount === 1);
    const prot = protByTitle.get(t.name) ?? [];
    const expectedProt = protectionsJson(idx).filter((p) => p.tab === t.name).length;
    check('protection', t.name, prot.length >= expectedProt && prot.every((p) => !p.warningOnly), `${prot.length}/${expectedProt} protected ranges (or warning-only)`);
    check('named-range', `${t.name}_KEYS`, named.has(`${t.name}_KEYS`));
    const row = s.data?.[0]?.rowData?.[0]?.values ?? [];
    const expectedVals = vals.filter((v) => v.tab === t.name);
    const missing = expectedVals.filter((v) => !row[Number(v.columnIndex)]?.dataValidation).map((v) => String(v.column));
    check('validation', t.name, missing.length === 0, `missing on: ${missing.slice(0, 6).join(', ')}`);
    void i;
  });
}

async function driveChecks(auth: ReturnType<typeof createGoogleAuth>, gw: SheetsGateway, checks: Check[]) {
  const drive = google.drive({ version: 'v3', auth });
  const cfg = (await gw.readRanges(['SYSTEM_CONFIG!A2:B60']))[0];
  for (const [k, v] of cfg) {
    if (!String(k).startsWith('DRIVE_') || !v) continue;
    try { await drive.files.get({ fileId: String(v), fields: 'id,name,trashed' }); checks.push({ area: 'drive', name: String(k), status: 'PASS' }); }
    catch (e) { checks.push({ area: 'drive', name: String(k), status: 'FAIL', detail: e instanceof Error ? e.message : String(e) }); }
  }
}

export function report(checks: Check[]): number {
  const worst = checks.some((c) => c.status === 'FAIL') ? 1 : 0;
  const by = (s: Check['status']) => checks.filter((c) => c.status === s).length;
  for (const c of checks.filter((x) => x.status !== 'PASS')) console.log(`${c.status.padEnd(4)} ${c.area.padEnd(10)} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  console.log(`\n${by('PASS')} passed, ${by('WARN')} warnings, ${by('FAIL')} failed, ${by('SKIP')} skipped`);
  return worst;
}

async function main() {
  const E = env();
  const checks: Check[] = [];
  if (process.argv.includes('--offline')) {
    const idx = buildTestSchema(60);
    const gw = new EmulatorGateway(idx);
    await applySeed(new SheetRepository(gw, idx, { cacheTtlMs: 0 }), idx, {});
    await commonChecks(gw, idx, checks);
    process.exit(report(checks));
  }
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set. See SETUP_GOOGLE.md');
  const auth = createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON });
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const gw = new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, auth);
  await googleStructureChecks(gw, E.GOOGLE_SPREADSHEET_ID, idx, checks);
  await commonChecks(gw, idx, checks);
  await driveChecks(auth, gw, checks);
  void formulasJson;
  process.exit(report(checks));
}

if (process.argv[1] && /verify-google-setup/.test(process.argv[1])) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
