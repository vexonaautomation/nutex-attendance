import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { TAB_ORDER, buildScaledSchema, formulaColumns, inputColumns, protectionsJson, renderGrid, validationsJson } from '@nutex/formula-specs';
import { OUT, generate } from '../../scripts/generate-apps-script';

/**
 * The Apps Script builder cannot run against real Google here, so it runs against a small in-memory spreadsheet that behaves like
 * Google Sheets where it matters: copying a formula down shifts its relative references, a formula that names a missing tab is an
 * error, and a dropdown that points at a missing tab is an error. The result is compared with the schema cell by cell.
 */
const SCALE = 0.01;

/** shift the relative row references of a formula by `by` rows (what Sheets does when a formula is copied down) */
function shiftRows(formula: string, by: number): string {
  return formula.split('"').map((part, i) => (i % 2 === 1 ? part : part.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, col: string, abs: string, row: string) => (abs ? m : `${col}${Number(row) + by}`)))).join('"');
}

class Cells { v = new Map<string, unknown>(); f = new Map<string, string>(); }

function makeEnv(sheetNames: () => string[]) {
  const log = { validations: new Map<string, number>(), named: new Set<string>(), protections: new Map<string, number>(), toasts: [] as string[], triggers: 0, deletedTriggers: 0, errors: [] as string[] };
  const props = new Map<string, string>();
  let triggers: Array<{ fn: string }> = [];
  const sheets: Sheet[] = [];
  const colNum = (s: string) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const checkRefs = (formula: string) => {
    for (const m of formula.matchAll(/([A-Z_]{3,})!/g)) if (!sheets.some((s) => s.name === m[1])) log.errors.push(`formula refers to a missing tab ${m[1]}: ${formula.slice(0, 80)}`);
  };

  class Range {
    constructor(public sh: Sheet, public r: number, public c: number, public nr: number, public nc: number) {}
    each(fn: (r: number, c: number, i: number, j: number) => void) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
    setValues(g: unknown[][]) { this.each((r, c, i, j) => { const x = g[i][j]; if (typeof x === 'string' && x.startsWith('=')) { checkRefs(x); this.sh.cells.f.set(`${r},${c}`, x); } else { this.sh.cells.f.delete(`${r},${c}`); this.sh.cells.v.set(`${r},${c}`, x); } }); return this; }
    setFormulas(g: string[][]) { this.each((r, c, i, j) => { checkRefs(g[i][j]); this.sh.cells.f.set(`${r},${c}`, g[i][j]); }); return this; }
    getValues() { const out: unknown[][] = []; for (let i = 0; i < this.nr; i++) { const row: unknown[] = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.cells.v.get(`${this.r + i},${this.c + j}`) ?? ''); out.push(row); } return out; }
    getFormulas() { const out: string[][] = []; for (let i = 0; i < this.nr; i++) { const row: string[] = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.cells.f.get(`${this.r + i},${this.c + j}`) ?? ''); out.push(row); } return out; }
    copyTo(dest: Range) { for (let k = 0; k < dest.nr; k++) for (let j = 0; j < this.nc; j++) { const f = this.sh.cells.f.get(`${this.r},${this.c + j}`); if (f !== undefined) dest.sh.cells.f.set(`${dest.r + k},${dest.c + j}`, shiftRows(f, dest.r + k - this.r)); } return this; }
    setDataValidation() { for (let j = 0; j < this.nc; j++) log.validations.set(this.sh.name, (log.validations.get(this.sh.name) ?? 0) + 1); return this; }
    setBackgrounds() { return this; } setFontColor() { return this; } setFontWeight() { return this; } setVerticalAlignment() { return this; } setWrapStrategy() { return this; } setNotes() { return this; } setNumberFormat() { return this; }
    protect() { return protection(this.sh.name); }
  }
  const protection = (tab: string) => { log.protections.set(tab, (log.protections.get(tab) ?? 0) + 1); const p = { setDescription: () => p, setWarningOnly: () => p, getEditors: () => [] as unknown[], removeEditors: () => p, addEditors: () => p, setDomainEdit: () => p, getDescription: () => '', remove: () => undefined }; return p; };

  class Sheet {
    cells = new Cells(); rows = 1000; cols = 26; rules: unknown[] = [];
    constructor(public name: string) {}
    getMaxRows() { return this.rows; } getMaxColumns() { return this.cols; }
    insertRowsAfter(_a: number, n: number) { this.rows += n; } deleteRows(_s: number, n: number) { this.rows -= n; }
    insertColumnsAfter(_a: number, n: number) { this.cols += n; } deleteColumns(_s: number, n: number) { this.cols -= n; }
    setTabColor() { return this; } setFrozenRows() { return this; } setFrozenColumns() { return this; } setColumnWidths() { return this; }
    getRange(r: number, c: number, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getLastRow() { return Math.max(0, ...[...this.cells.v.keys()].map((k) => Number(k.split(',')[0]))); } getLastColumn() { return Math.max(0, ...[...this.cells.v.keys()].map((k) => Number(k.split(',')[1]))); }
    getName() { return this.name; }
    getConditionalFormatRules() { return this.rules; } setConditionalFormatRules(r: unknown[]) { this.rules = r; }
    getProtections() { return [] as unknown[]; }
    protect() { return protection(this.name); }
  }

  const builder = (kind: string) => { const b: Record<string, unknown> = {}; const chain = () => b; for (const m of ['requireValueInList', 'requireValueInRange', 'requireDate', 'requireFormulaSatisfied', 'setAllowInvalid', 'setHelpText', 'whenFormulaSatisfied', 'setBackground', 'setRanges']) b[m] = (...a: unknown[]) => { if (m === 'requireValueInRange' && !(a[0] instanceof Range)) log.errors.push('dropdown range is not a range'); return chain(); }; b.build = () => ({ kind }); return b; };

  const ss = {
    rename: () => undefined, setSpreadsheetLocale: () => undefined, setSpreadsheetTimeZone: () => undefined, toast: (m: string) => { log.toasts.push(m); }, flush: () => undefined,
    getSheetByName: (n: string) => sheets.find((s) => s.name === n) ?? null,
    getSheets: () => sheets, insertSheet: (n: string, i: number) => { const s = new Sheet(n); sheets.splice(i, 0, s); return s; }, deleteSheet: (s: Sheet) => { sheets.splice(sheets.indexOf(s), 1); },
    setActiveSheet: () => undefined, setNamedRange: (n: string) => { log.named.add(n); },
    getRange: (a1: string) => {
      const m = /^([A-Z_]+)!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(a1);
      if (!m) throw new Error(`bad range ${a1}`);
      const sh = sheets.find((s) => s.name === m[1]);
      if (!sh) throw new Error(`range on a missing tab: ${a1}`);
      return new Range(sh, Number(m[3]), colNum(m[2]), Number(m[5]) - Number(m[3]) + 1, colNum(m[4]) - colNum(m[2]) + 1);
    },
  };
  sheets.push(new Sheet('Sheet1'));
  void sheetNames;

  const sandbox: Record<string, unknown> = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() { return undefined; } }), alert: (t: string, m: string) => { log.toasts.push(`ALERT ${t}: ${m}`); }, ButtonSet: { OK: 'OK' } }),
      newDataValidation: () => builder('dv'), newConditionalFormatRule: () => builder('cf'), WrapStrategy: { CLIP: 'CLIP' }, CopyPasteType: { PASTE_FORMULA: 'F' }, ProtectionType: { RANGE: 'R', SHEET: 'S' },
      flush: () => undefined,
    },
    PropertiesService: { getDocumentProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => { props.set(k, v); }, deleteProperty: (k: string) => { props.delete(k); } }) },
    ScriptApp: { newTrigger: (fn: string) => ({ timeBased: () => ({ after: () => ({ create: () => { triggers.push({ fn }); log.triggers++; } }) }) }), getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn })), deleteTrigger: () => { triggers = triggers.slice(1); log.deletedTriggers++; } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Date, console, JSON, Math, Object, Array, String, Number, Error,
  };
  return { sandbox, sheets, log, props, getTriggers: () => triggers };
}

function run(src: string, o: { serviceAccount?: string; budget?: number; clockStepMs?: number } = {}) {
  const env = makeEnv(() => []);
  let now = 1_000_000;
  if (o.clockStepMs) env.sandbox.Date = class extends Date { static now() { now += o.clockStepMs!; return now; } };
  const ctx = vm.createContext(env.sandbox);
  vm.runInContext(src, ctx);
  if (o.serviceAccount) vm.runInContext(`NUTEX_SETTINGS.SERVICE_ACCOUNT_EMAIL = '${o.serviceAccount}'`, ctx);
  if (o.budget !== undefined) vm.runInContext(`NUTEX_BUDGET_MS = ${o.budget}`, ctx);
  return { env, ctx, call: (fn: string) => vm.runInContext(`${fn}()`, ctx) };
}

const src = generate(SCALE);
const idx = buildScaledSchema(SCALE);

describe('generated Apps Script', () => {
  it('is valid JavaScript and the committed file is current (npm run apps-script:generate)', () => {
    expect(() => new vm.Script(src)).not.toThrow();
    expect(readFileSync(OUT, 'utf8')).toBe(generate(0.25));
  });

  it('builds all tabs in order with every header, formula, dropdown, named range and protection', () => {
    const { env, call } = run(src, { serviceAccount: 'nutex-api@demo.iam.gserviceaccount.com' });
    call('nutexBuild');
    expect(env.log.errors).toEqual([]);
    expect(env.sheets.map((s) => s.name)).toEqual([...TAB_ORDER]); // the blank default sheet is gone
    for (const t of idx.tabs) {
      const sh = env.sheets.find((s) => s.name === t.name)!;
      const rows = idx.rowsFor(t);
      expect(sh.rows, `${t.name} rows`).toBe(rows + 1);
      expect(sh.cols).toBe(t.columns.length + 1);
      expect(sh.getRange(1, 1, 1, t.columns.length).getValues()[0], `${t.name} headers`).toEqual(t.columns.map((c) => c.name));
      // every formula cell of every row is exactly what the schema renders for that row
      const grid = renderGrid(idx, t);
      const fcols = t.columns.map((c, i) => (c.kind === 'formula' ? i : -1)).filter((i) => i >= 0);
      const nRows = t.fixedRows ? t.fixedRows.length : rows;
      for (let r = 1; r <= nRows; r++) {
        for (const ci of fcols) {
          const want = String(grid[r][ci] ?? '');
          if (!want.startsWith('=')) continue;
          expect(sh.cells.f.get(`${r + 1},${ci + 1}`), `${t.name} ${t.columns[ci].name} row ${r + 1}`).toBe(want);
        }
      }
      // dropdowns / checks: one per input column the schema validates
      const expected = validationsJson(idx).filter((v) => v.tab === t.name).length;
      expect(env.log.validations.get(t.name) ?? 0, `${t.name} validations`).toBe(expected);
      expect(env.log.named.has(`${t.name}_KEYS`)).toBe(true);
      const hasF = formulaColumns(t).length > 0;
      expect(env.log.protections.get(t.name), `${t.name} protections`).toBe(t.protection === 'SERVICE_ONLY' ? 1 : 1 + (hasF ? 1 : 0));
      void inputColumns;
    }
    expect(protectionsJson(idx).length).toBeGreaterThan(0);
    const lookups = env.sheets.find((s) => s.name === 'LOOKUPS')!;
    expect(lookups.cells.v.get('2,1')).toBe('ACTIVE'); // RECORD_STATUS list
    expect(env.sheets.find((s) => s.name === 'README')!.cells.v.get('2,1')).toBe('SYSTEM_CONFIG');
    expect(env.props.size).toBe(0); // progress marker cleaned up
    expect(env.log.toasts.some((t) => /Workbook built/.test(t))).toBe(true);
  });

  it('resumes by itself when the time budget runs out and still ends in the same workbook', () => {
    const { env, call, ctx } = run(src, { serviceAccount: 'nutex-api@demo.iam.gserviceaccount.com', clockStepMs: 4000 });
    let rounds = 0;
    do { call('nutexBuild'); rounds++; } while (env.props.has('nutex_build') && rounds < 100);
    expect(rounds).toBeGreaterThan(1);
    expect(env.log.triggers).toBe(rounds - 1);
    expect(env.log.errors).toEqual([]);
    expect(env.sheets.map((s) => s.name)).toEqual([...TAB_ORDER]);
    expect(vm.runInContext('nutexCheck.name', ctx)).toBe('nutexCheck');
    env.log.toasts.length = 0;
    call('nutexCheck');
    expect(env.log.toasts.join('\n')).toMatch(/NUTEX check: OK|check: [1-9]/);
  });

  it('skips protections politely when no service account is set, and refuses a sheet that already has NUTEX tabs', () => {
    const a = run(src);
    a.call('nutexBuild');
    expect(a.env.log.protections.size).toBe(0);
    expect(a.env.log.toasts.some((t) => /Protections skipped/.test(t))).toBe(true);
    const b = run(src);
    b.env.sheets.push({ name: 'USERS' } as never); // somebody already built (part of) NUTEX here
    expect(() => b.call('nutexBuild')).toThrow(/already has NUTEX tabs/);
  });
});
