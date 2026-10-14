import { ColumnDef, SchemaIndex, TabDef, BuildOptions, assertLayout, colLetter, formulaColumns, inp, inputColumns, resolveFormula } from './dsl';
import { ENUMS } from './enums';
import { CORE_TABS } from './tabs-core';
import { ATTENDANCE_TABS } from './tabs-attendance';
import { LEAVE_TABS } from './tabs-leave';
import { PAYROLL_TABS, COMPONENTS } from './tabs-payroll';
import { SYSTEM_TABS } from './tabs-system';

export * from './dsl';
export * from './enums';
export * from './defaults';
export { COMPONENTS };

export const WORKBOOK_NAME = 'NUTEX Attendance & Payroll DB';
export const SCHEMA_VERSION = '2.0.0';

/** exact tab order required by the spec (+ PAYROLL_SNAPSHOT which makes locked payroll reproducible) */
export const TAB_ORDER = [
  'SYSTEM_CONFIG', 'USERS', 'ROLES', 'EMPLOYEES', 'EMPLOYMENT_HISTORY', 'EMPLOYEE_DOCUMENTS', 'DEPARTMENTS', 'DESIGNATIONS', 'LOCATIONS', 'SHIFT_MASTER', 'SHIFT_ROSTER', 'HOLIDAYS',
  'LEAVE_TYPES', 'LEAVE_POLICIES', 'LEAVE_BALANCES', 'LEAVE_TRANSACTIONS', 'LEAVE_APPLICATIONS', 'ATTENDANCE_EVENTS', 'ATTENDANCE_DAILY', 'ATTENDANCE_ADJUSTMENTS',
  'ATTENDANCE_EXCEPTIONS', 'OVERTIME', 'TIMESHEETS', 'SALARY_COMPONENTS', 'EMPLOYEE_SALARY', 'PAYROLL_CONTROL', 'PAYROLL_INPUTS', 'PAYROLL_CALC', 'PAYROLL_SNAPSHOT',
  'PAYSLIPS', 'LOANS', 'LOAN_SCHEDULE', 'EXPENSES', 'REIMBURSEMENTS', 'TAX_DECLARATIONS', 'STATUTORY_RULES', 'STATUTORY_CALC', 'FULL_FINAL',
  'NOTIFICATIONS', 'AUDIT_LOG', 'ERROR_LOG', 'DASHBOARD_DATA', 'LOOKUPS', 'README',
] as const;

function lookupsTab(base: TabDef): TabDef {
  const names = Object.keys(ENUMS);
  return { ...base, columns: names.map((n) => inp(n)), capacity: Math.max(...Object.values(ENUMS).map((v) => v.length)) + 10 };
}

export function allTabs(): TabDef[] {
  const all = [...CORE_TABS, ...ATTENDANCE_TABS, ...LEAVE_TABS, ...PAYROLL_TABS, ...SYSTEM_TABS].map((t) => (t.name === 'LOOKUPS' ? lookupsTab(t) : t));
  const byName = new Map(all.map((t) => [t.name, t]));
  const ordered = TAB_ORDER.map((n) => {
    const t = byName.get(n);
    if (!t) throw new Error(`Tab ${n} is not defined`);
    return t;
  });
  for (const t of ordered) assertLayout(t);
  return ordered;
}

/** Production schema (full capacity). */
export function buildSchema(opts: BuildOptions = {}): SchemaIndex {
  return new SchemaIndex(allTabs(), opts);
}

/**
 * Production schema with capacities scaled by CAPACITY_SCALE (default 1). Use < 1 for small companies so the workbook stays far
 * below Google's 10M cell limit; setup scripts, the API and verify scripts must all use the same value.
 */
export function buildScaledSchema(scale = 1): SchemaIndex {
  if (!(scale > 0 && scale <= 1)) throw new Error('CAPACITY_SCALE must be in (0, 1]');
  return new SchemaIndex(allTabs(), { rows: (t) => Math.max(Math.min(t.capacity, 200), Math.ceil(t.capacity * scale)) });
}

export function totalCells(idx: SchemaIndex): number {
  return idx.tabs.reduce((n, t) => n + (idx.rowsFor(t) + 1) * t.columns.length, 0);
}

/** Tiny capacities for fast local verification / tests. */
export function buildTestSchema(rows = 80, big: Record<string, number> = {}): SchemaIndex {
  const per: Record<string, number> = {
    SYSTEM_CONFIG: 40, ROLES: 300, LOOKUPS: 60, ATTENDANCE_EVENTS: 200, ATTENDANCE_DAILY: 150, DASHBOARD_DATA: 60, STATUTORY_RULES: 60, README: 60, USERS: 30,
    AUDIT_LOG: 30, ERROR_LOG: 10, NOTIFICATIONS: 10, EMPLOYMENT_HISTORY: 10, ...big,
  };
  return new SchemaIndex(allTabs(), { rows: (t) => per[t.name] ?? Math.min(t.capacity, rows) });
}

/** README tab content derived from the schema */
export function readmeRows(idx: SchemaIndex): Array<Record<string, string | number>> {
  return idx.tabs
    .filter((t) => t.name !== 'README')
    .map((t) => ({
      tab: t.name, group: t.group, purpose: t.purpose, append_only: t.appendOnly ? 'YES' : 'no',
      protection: t.protection === 'SERVICE_ONLY' ? 'Whole tab locked (service account / super admin only)' : 'Formula columns locked; input columns edited via app',
      input_columns: inputColumns(t).length, formula_columns: formulaColumns(t).length, capacity_rows: idx.rowsFor(t),
    }));
}

export type Cell = string | number | boolean | null;

/**
 * Full grid for a tab as it is created by the setup script: header row + pre-filled formula rows (+ fixed rows).
 * Input cells are left empty; seed / API writes fill them later.
 */
export function renderGrid(idx: SchemaIndex, tab: TabDef, opts: { rows?: number } = {}): Cell[][] {
  const rows = opts.rows ?? idx.rowsFor(tab);
  const header: Cell[] = tab.columns.map((c) => c.name);
  const grid: Cell[][] = [header];
  const fx = formulaColumns(tab);
  if (!fx.length && !tab.fixedRows) return grid;
  const total = tab.fixedRows ? Math.max(rows, tab.fixedRows.length) : rows;
  for (let r = 0; r < total; r++) {
    const sheetRow = r + 2;
    const fixed = tab.fixedRows?.[r];
    const line: Cell[] = tab.columns.map((c) => {
      if (fixed && fixed[c.name] !== undefined) {
        const v = fixed[c.name];
        return typeof v === 'string' && v.startsWith('=') ? resolveFormula(idx, tab, v, sheetRow) : v;
      }
      if (c.kind === 'formula' && c.formula) return resolveFormula(idx, tab, c.formula, sheetRow);
      return null;
    });
    grid.push(line);
  }
  return grid;
}

export function inputRange(idx: SchemaIndex, tab: TabDef, row: number): string {
  const n = inputColumns(tab).length;
  return `${tab.name}!A${row}:${colLetter(n - 1)}${row}`;
}

// ------------------------------------------------------------------ JSON artefacts for google/sheet-schema

const FORMAT: Record<string, string | undefined> = {
  date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm:ss', time: 'hh:mm', money: '#,##0.00', percent: '0.00%',
};

export function workbookSchemaJson(idx: SchemaIndex) {
  return {
    workbook: WORKBOOK_NAME, schemaVersion: SCHEMA_VERSION,
    tabs: idx.tabs.map((t, i) => ({
      order: i, name: t.name, group: t.group, purpose: t.purpose, appendOnly: !!t.appendOnly, protection: t.protection,
      capacity: idx.rowsFor(t), keyColumn: t.keyColumn, freezeRows: 1, freezeColumns: 1,
      columns: t.columns.map((c, ci) => ({ index: ci, letter: colLetter(ci), name: c.name, kind: c.kind, type: c.type, enum: c.enum, ref: c.ref, required: !!c.required, numberFormat: FORMAT[c.type], note: c.note })),
    })),
    namedRanges: idx.tabs.flatMap((t) => {
      const kc = idx.colIndex(t, t.keyColumn);
      return [{ name: `${t.name}_KEYS`, range: `${t.name}!${colLetter(kc)}2:${colLetter(kc)}${idx.rowsFor(t) + 1}` }];
    }),
  };
}

export function headersJson(idx: SchemaIndex) {
  return Object.fromEntries(idx.tabs.map((t) => [t.name, t.columns.map((c) => c.name)]));
}

export function formulasJson(idx: SchemaIndex) {
  const out: Record<string, Array<{ column: string; letter: string; type: string; template: string; row2: string; note?: string }>> = {};
  for (const t of idx.tabs) {
    const cols = t.columns.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'formula' && x.c.formula);
    if (cols.length) {
      out[t.name] = cols.map(({ c, i }) => ({ column: c.name, letter: colLetter(i), type: c.type, template: c.formula!, row2: resolveFormula(idx, t, c.formula!, 2), note: c.note }));
    }
    if (t.fixedRows) {
      out[t.name] = t.fixedRows.map((r, ri) => {
        const vc = t.columns.findIndex((c) => c.name === 'value');
        return { column: String(r.metric_key), letter: colLetter(vc), type: 'text', template: String(r.value), row2: resolveFormula(idx, t, String(r.value), ri + 2), note: String(r.label) };
      });
    }
  }
  return out;
}

export function validationsJson(idx: SchemaIndex) {
  const out: Array<Record<string, unknown>> = [];
  for (const t of idx.tabs) {
    const last = idx.rowsFor(t) + 1;
    t.columns.forEach((c: ColumnDef, i) => {
      if (c.kind !== 'input') return;
      const range = { sheet: t.name, columnIndex: i, startRow: 2, endRow: last };
      if (c.enum) out.push({ tab: t.name, column: c.name, ...range, type: 'ONE_OF_LIST', values: ENUMS[c.enum], strict: true });
      else if (c.ref) {
        const [rt, rc] = c.ref.split('.');
        out.push({ tab: t.name, column: c.name, ...range, type: 'ONE_OF_RANGE', source: idx.range(rt, rc), strict: false });
      } else if (c.type === 'date' || c.type === 'datetime') out.push({ tab: t.name, column: c.name, ...range, type: 'DATE_IS_VALID', strict: false });
      else if (c.type === 'number' || c.type === 'money' || c.type === 'percent') out.push({ tab: t.name, column: c.name, ...range, type: 'NUMBER_VALID', strict: false });
    });
  }
  return out;
}

export function protectionsJson(idx: SchemaIndex) {
  const out: Array<Record<string, unknown>> = [];
  for (const t of idx.tabs) {
    const last = idx.rowsFor(t) + 1;
    if (t.protection === 'SERVICE_ONLY') {
      out.push({ tab: t.name, description: `${t.name}: whole tab locked${t.appendOnly ? ' (append-only)' : ''}`, range: null, editors: 'SERVICE_ACCOUNT_AND_SUPER_ADMIN', warningOnly: false });
    } else {
      const fcols = t.columns.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'formula');
      if (fcols.length) {
        out.push({ tab: t.name, description: `${t.name}: formula block ${fcols[0].c.name}..${fcols[fcols.length - 1].c.name}`, range: { columnIndex: fcols[0].i, endColumnIndex: fcols[fcols.length - 1].i, startRow: 2, endRow: last }, editors: 'SERVICE_ACCOUNT_AND_SUPER_ADMIN', warningOnly: false });
      }
    }
    if (t.protection === 'FORMULA_ONLY') {
      out.push({ tab: t.name, description: `${t.name}: header row`, range: { columnIndex: 0, startRow: 1, endRow: 1, allColumns: true }, editors: 'SERVICE_ACCOUNT_AND_SUPER_ADMIN', warningOnly: false });
    }
  }
  return out;
}
