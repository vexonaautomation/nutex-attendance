/**
 * Schema DSL for the NUTEX workbook.
 *
 * Every business calculation lives here as a Google Sheets formula template. Templates use a tiny macro layer
 * so that formulas stay readable and stay correct if columns are re-ordered:
 *
 *   @col                         cell in the current row of the current tab (e.g. @employee_id -> A5)
 *   [TAB.col]                    full data range of a column (e.g. [HOLIDAYS.date] -> HOLIDAYS!$B$2:$B$400)
 *   $CFG(KEY)                    value of a SYSTEM_CONFIG key
 *   $RULE(CODE, dateExpr)        effective-dated value from STATUTORY_RULES for CODE on dateExpr
 *   $LK(TAB.ret, TAB.key, expr)  INDEX/MATCH exact lookup (errors if missing)
 *   $LKD(TAB.ret, TAB.key, expr, default)  same, with default when missing
 *
 * Only functions that exist in BOTH Google Sheets and the local HyperFormula verification engine are used.
 */

export type ColType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'time' | 'yn' | 'enum' | 'json' | 'id';

export interface ColumnDef {
  name: string;
  kind: 'input' | 'formula';
  type: ColType;
  enum?: string;
  /** master tab column this value must reference, e.g. "DEPARTMENTS.department_id" */
  ref?: string;
  required?: boolean;
  formula?: string;
  note?: string;
}

export type ProtectionLevel = 'SERVICE_ONLY' | 'FORMULA_ONLY';

export interface TabDef {
  name: string;
  group: string;
  purpose: string;
  columns: ColumnDef[];
  /** rows are never edited or deleted after being written */
  appendOnly?: boolean;
  /** SERVICE_ONLY = whole tab locked to service account / super admin. FORMULA_ONLY = only formula columns locked. */
  protection: ProtectionLevel;
  /** production capacity in data rows (formulas are pre-filled for this many rows) */
  capacity: number;
  /** column that identifies a populated row */
  keyColumn: string;
  /** tab holds a single-row-per-key configuration table cached by the API */
  cacheable?: boolean;
  /** pre-seeded rows; a string value starting with "=" is a formula template resolved per row */
  fixedRows?: Array<Record<string, string | number>>;
}

export const inp = (name: string, type: ColType = 'text', o: Partial<ColumnDef> = {}): ColumnDef => ({ name, kind: 'input', type, ...o });
export const id = (name: string, o: Partial<ColumnDef> = {}): ColumnDef => inp(name, 'id', { required: true, ...o });
export const en = (name: string, enumName: string, o: Partial<ColumnDef> = {}): ColumnDef => inp(name, 'enum', { enum: enumName, ...o });
export const fx = (name: string, formula: string, type: ColType = 'text', o: Partial<ColumnDef> = {}): ColumnDef => ({ name, kind: 'formula', type, formula, ...o });

/** standard audit / lifecycle columns appended to master + transaction tabs */
export const aud = (statusEnum = 'RECORD_STATUS'): ColumnDef[] => [
  inp('company_id', 'text'),
  inp('created_at', 'datetime'),
  inp('created_by', 'text'),
  inp('updated_at', 'datetime'),
  inp('updated_by', 'text'),
  inp('source', 'text'),
  inp('request_id', 'text'),
  en('status', statusEnum),
  inp('notes', 'text'),
];

export function colLetter(idx0: number): string {
  let n = idx0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface BuildOptions {
  /** rows to pre-fill formulas for, by tab; falls back to tab.capacity */
  rows?: Record<string, number> | ((tab: TabDef) => number);
}

export class SchemaIndex {
  constructor(public readonly tabs: TabDef[], public readonly opts: BuildOptions = {}) {
    this.byName = new Map(tabs.map((t) => [t.name, t]));
  }
  readonly byName: Map<string, TabDef>;

  tab(name: string): TabDef {
    const t = this.byName.get(name);
    if (!t) throw new Error(`Unknown tab ${name}`);
    return t;
  }

  rowsFor(tab: TabDef): number {
    const r = this.opts.rows;
    if (typeof r === 'function') return r(tab);
    if (r && r[tab.name] !== undefined) return r[tab.name];
    if (r && r['*'] !== undefined) return r['*'];
    return tab.capacity;
  }

  colIndex(tab: TabDef, col: string): number {
    const i = tab.columns.findIndex((c) => c.name === col);
    if (i < 0) throw new Error(`Unknown column ${tab.name}.${col}`);
    return i;
  }

  letter(tabName: string, col: string): string {
    return colLetter(this.colIndex(this.tab(tabName), col));
  }

  /** absolute full-column data range e.g. HOLIDAYS!$B$2:$B$400 */
  range(tabName: string, col: string): string {
    const t = this.tab(tabName);
    const L = colLetter(this.colIndex(t, col));
    return `${tabName}!$${L}$2:$${L}$${this.rowsFor(t) + 1}`;
  }
}

/** split a macro argument string at top-level commas (respects parentheses, brackets and quotes) */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** find the matching close paren for the open paren at `open` */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced parentheses in: ${s}`);
}

function expandMacros(s: string): string {
  const re = /\$(CFG|RULE|LKD|LK)\(/;
  for (;;) {
    const m = re.exec(s);
    if (!m) return s;
    const open = m.index + m[0].length - 1;
    const close = matchParen(s, open);
    const args = splitArgs(s.slice(open + 1, close)).map(expandMacros);
    let rep: string;
    switch (m[1]) {
      case 'CFG':
        rep = `INDEX([SYSTEM_CONFIG.value],MATCH("${args[0]}",[SYSTEM_CONFIG.key],0))`;
        break;
      case 'RULE':
        rep = `SUMIFS([STATUTORY_RULES.value],[STATUTORY_RULES.rule_code],"${args[0]}",[STATUTORY_RULES.effective_from],"<="&(${args[1]}),[STATUTORY_RULES.effective_to_norm],">="&(${args[1]}),[STATUTORY_RULES.status],"ACTIVE")`;
        break;
      case 'LK':
        rep = `INDEX([${args[0]}],MATCH(${args[2]},[${args[1]}],0))`;
        break;
      default:
        rep = `IFERROR(INDEX([${args[0]}],MATCH(${args[2]},[${args[1]}],0)),${args[3]})`;
    }
    s = s.slice(0, m.index) + rep + s.slice(close + 1);
  }
}

/** Resolve one formula template into a concrete A1 formula for a given sheet row (1-based sheet row). */
export function resolveFormula(idx: SchemaIndex, tab: TabDef, template: string, row: number): string {
  let f = expandMacros(template);
  f = f.replace(/\[([A-Z_]+)\.([a-z0-9_]+)\]/g, (_m, t, c) => idx.range(t, c));
  f = f.replace(/(^|[^A-Za-z0-9_"!$])@([a-z][a-z0-9_]*)/g, (_m, pre, c) => `${pre}${colLetter(idx.colIndex(tab, c))}${row}`);
  f = f.replace(/\{FRANGE:([A-Z_]+)\}/g, (_m, t) => {
    const tt = idx.tab(t);
    const fc = tt.columns.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'formula');
    const n = idx.rowsFor(tt) + 1;
    return `${t}!$${colLetter(fc[0].i)}$2:$${colLetter(fc[fc.length - 1].i)}$${n}`;
  });
  return f.startsWith('=') ? f : `=${f}`;
}

export function inputColumns(tab: TabDef): ColumnDef[] {
  return tab.columns.filter((c) => c.kind === 'input');
}
export function formulaColumns(tab: TabDef): ColumnDef[] {
  return tab.columns.filter((c) => c.kind === 'formula');
}

/** Structural rule: inputs first, formulas last, so appends can write A:lastInput without touching formulas. */
export function assertLayout(tab: TabDef): void {
  let seenFormula = false;
  for (const c of tab.columns) {
    if (c.kind === 'formula') seenFormula = true;
    else if (seenFormula) throw new Error(`${tab.name}.${c.name}: input column after formula column`);
  }
}
