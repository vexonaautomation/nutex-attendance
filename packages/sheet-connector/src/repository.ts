import { SchemaIndex, TabDef, colLetter, formulaColumns, inputColumns, renderGrid } from '@nutex/formula-specs';
import { SheetsGateway } from './gateway';
import { KeyedMutex, ReadCache } from './infra';
import { CellValue, fromCell, toCell } from './serial';

export type Row = Record<string, string | number | null> & { _row: number };
export type Input = Record<string, unknown>;

export class CapacityError extends Error {
  constructor(public tab: string, public capacity: number) {
    super(`${tab} reached its formula capacity of ${capacity} rows. Extend capacity or archive closed periods (see docs/operations-runbook.md).`);
    this.name = 'CapacityError';
  }
}
export class ImmutableError extends Error {
  constructor(tab: string, detail = 'is append-only') {
    super(`${tab} ${detail}; create a new record or an adjustment instead of editing history.`);
    this.name = 'ImmutableError';
  }
}
export class NotFoundError extends Error {
  constructor(tab: string, key: string) {
    super(`${tab}: record ${key} not found`);
    this.name = 'NotFoundError';
  }
}

/** `verify: false` skips the read-back after an append (only for logs that verify themselves) */
export interface AppendOptions { verify?: boolean }

export interface RepoOptions {
  cacheTtlMs?: number;
  configCacheTtlMs?: number;
  mutex?: KeyedMutex;
}

/**
 * Typed, batched access to workbook tabs. Business calculations are NOT done here: the repository reads formula
 * results as-is and writes only input columns (formula columns are never written).
 *
 * Speed on real Google Sheets is decided by the NUMBER OF API CALLS (about 0.4 s each, size hardly matters), so:
 *  - a read is ONE call (the whole tab; after the first read only the used rows plus a margin);
 *  - a write only drops the cached tabs that can change because of it: the tab itself and the tabs whose formulas read it
 *    (so an audit entry or a last-login stamp no longer throws the whole cache away);
 *  - tabs without formula columns are not read back after a write (the result is known), and appends verify with one read.
 */
export class SheetRepository {
  private cache: ReadCache<Row[]>;
  private mutex: KeyedMutex;
  private configTtl: number;
  /** last known number of used rows per tab (avoids a second call to find the end of the data) */
  private used = new Map<string, { n: number; at: number }>();
  private dependentsOf: Map<string, string[]> | undefined;

  constructor(readonly gateway: SheetsGateway, readonly idx: SchemaIndex, opts: RepoOptions = {}) {
    this.cache = new ReadCache<Row[]>(opts.cacheTtlMs ?? 2_000);
    this.configTtl = opts.configCacheTtlMs ?? 60_000;
    this.mutex = opts.mutex ?? new KeyedMutex();
  }

  tab(name: string): TabDef { return this.idx.tab(name); }

  private lastCol(tab: TabDef): string { return colLetter(tab.columns.length - 1); }

  private hasFormulas(tab: TabDef): boolean { return !!tab.fixedRows || formulaColumns(tab).length > 0; }

  /** which tabs' formulas read each tab, directly or through other tabs (built once from the schema) */
  private dependents(tab: string): string[] {
    if (!this.dependentsOf) {
      const readers = new Map<string, Set<string>>(); // tab -> tabs that read it directly
      const names = new Set(this.idx.tabs.map((t) => t.name));
      for (const t of this.idx.tabs) {
        if (!this.hasFormulas(t)) continue;
        const grid = renderGrid(this.idx, t, { rows: 1 });
        for (const line of grid.slice(1)) for (const cell of line) {
          if (typeof cell !== 'string' || !cell.startsWith('=')) continue;
          for (const m of cell.matchAll(/\b([A-Z][A-Z_]+)!/g)) if (names.has(m[1]) && m[1] !== t.name) (readers.get(m[1]) ?? readers.set(m[1], new Set()).get(m[1])!).add(t.name);
        }
      }
      this.dependentsOf = new Map();
      for (const t of this.idx.tabs) {
        const seen = new Set<string>();
        const stack = [t.name];
        while (stack.length) for (const r of readers.get(stack.pop()!) ?? []) if (!seen.has(r)) { seen.add(r); stack.push(r); }
        this.dependentsOf.set(t.name, [...seen]);
      }
    }
    return this.dependentsOf.get(tab) ?? [];
  }

  private invalidateFor(tab: TabDef): void {
    this.cache.delete(tab.name);
    for (const d of this.dependents(tab.name)) this.cache.delete(d);
  }

  /** the end of the data: from memory when we know it (single instance, every write goes through here), else one extra call */
  private async usedRows(tab: TabDef, maxAgeMs = 60_000): Promise<number> {
    const known = this.used.get(tab.name);
    if (known && Date.now() - known.at < maxAgeMs) return known.n;
    const kc = colLetter(this.idx.colIndex(tab, tab.keyColumn));
    const cap = this.idx.rowsFor(tab);
    const [col] = await this.gateway.readRanges([`${tab.name}!${kc}2:${kc}${cap + 1}`]);
    let last = 0;
    col.forEach((r, i) => { if (r[0] !== null && r[0] !== '') last = i + 1; });
    this.used.set(tab.name, { n: last, at: Date.now() });
    return last;
  }

  private toRow(tab: TabDef, line: CellValue[], sheetRow: number): Row {
    const row: Row = { _row: sheetRow } as Row;
    tab.columns.forEach((c, i) => { row[c.name] = fromCell(c.type, line[i]); });
    return row;
  }

  private parse(tab: TabDef, grid: CellValue[][]): { rows: Row[]; last: number } {
    const kIdx = this.idx.colIndex(tab, tab.keyColumn);
    const rows: Row[] = [];
    let last = 0;
    grid.forEach((line, i) => { if (line[kIdx] !== null && line[kIdx] !== '') { rows.push(this.toRow(tab, line, i + 2)); last = i + 1; } });
    return { rows, last };
  }

  /**
   * All populated rows (input + formula results) in ONE call. The first read takes the whole tab; later reads take the rows used
   * so far plus a margin, and fall back to the whole tab if the margin is filled (rows added from outside).
   */
  async readAll(tabName: string): Promise<Row[]> {
    const tab = this.tab(tabName);
    const ttl = tab.cacheable ? this.configTtl : undefined;
    return this.cache.get(tabName, async () => {
      const cap = this.idx.rowsFor(tab);
      const known = this.used.get(tabName);
      const limit = known ? Math.min(cap, known.n + 25) : cap;
      const read = async (n: number) => this.parse(tab, (await this.gateway.readRanges([`${tab.name}!A2:${this.lastCol(tab)}${n + 1}`]))[0]);
      let res = await read(limit);
      if (limit < cap && res.last >= limit) res = await read(cap);
      this.used.set(tabName, { n: res.last, at: Date.now() });
      return res.rows;
    }, ttl);
  }

  async find(tabName: string, pred: (r: Row) => boolean): Promise<Row[]> {
    return (await this.readAll(tabName)).filter(pred);
  }

  async findOne(tabName: string, pred: (r: Row) => boolean): Promise<Row | undefined> {
    return (await this.readAll(tabName)).find(pred);
  }

  async getByKey(tabName: string, key: string): Promise<Row | undefined> {
    const tab = this.tab(tabName);
    return this.findOne(tabName, (r) => String(r[tab.keyColumn]) === key);
  }

  private inputCells(tab: TabDef, data: Input): CellValue[] {
    const cols = inputColumns(tab);
    const unknown = Object.keys(data).filter((k) => !tab.columns.some((c) => c.name === k));
    if (unknown.length) throw new Error(`${tab.name}: unknown column(s) ${unknown.join(', ')}`);
    const formulaTouch = Object.keys(data).filter((k) => tab.columns.find((c) => c.name === k)?.kind === 'formula');
    if (formulaTouch.length) throw new Error(`${tab.name}: formula column(s) are read-only: ${formulaTouch.join(', ')}`);
    return cols.map((c) => {
      const v = data[c.name];
      if (c.required && (v === undefined || v === null || v === '')) throw new Error(`${tab.name}.${c.name} is required`);
      return toCell(c.type, v);
    });
  }

  /** append a row after the last used row. Serialised per tab; verifies the write by reading the new rows back (one call). */
  async append(tabName: string, data: Input, o: AppendOptions = {}): Promise<Row> {
    const [row] = await this.appendMany(tabName, [data], o);
    return row;
  }

  async appendMany(tabName: string, items: Input[], o: AppendOptions = {}): Promise<Row[]> {
    if (!items.length) return [];
    const tab = this.tab(tabName);
    const cap = this.idx.rowsFor(tab);
    const cells = items.map((d) => this.inputCells(tab, d));
    return this.mutex.run(`append:${tabName}`, async () => {
      const used = await this.usedRows(tab);
      const start = used + 2;
      if (used + items.length > cap) throw new CapacityError(tab.name, cap);
      const last = colLetter(inputColumns(tab).length - 1);
      await this.gateway.writeRanges([{ range: `${tab.name}!A${start}:${last}${start + items.length - 1}`, values: cells }]);
      this.invalidateFor(tab);
      if (o.verify === false) {
        // append-only logs that carry their own integrity check (the audit hash chain): no read-back, one call less
        this.used.set(tab.name, { n: used + items.length, at: Date.now() });
        return items.map((d, i) => ({ _row: start + i, ...Object.fromEntries(Object.keys(d).filter((k) => tab.columns.some((c) => c.name === k)).map((k) => [k, this.echo(tab, k, d[k])])) }) as Row);
      }
      const keyIdx = inputColumns(tab).findIndex((c) => c.name === tab.keyColumn);
      const [grid] = await this.gateway.readRanges([`${tab.name}!A${start}:${this.lastCol(tab)}${start + items.length - 1}`]);
      const kIdx = this.idx.colIndex(tab, tab.keyColumn);
      grid.forEach((line, i) => {
        if (String(line[kIdx]) !== String(cells[i][keyIdx])) {
          this.used.delete(tab.name); // somebody else wrote here: forget what we assumed about the end of the data
          throw new Error(`${tab.name}: write verification failed at row ${start + i} (concurrent writer?)`);
        }
      });
      this.used.set(tab.name, { n: used + items.length, at: Date.now() });
      return grid.map((line, i) => this.toRow(tab, line, start + i));
    });
  }

  /** idempotent append: returns the existing row when `uniqueColumn` already holds `value` */
  async appendIfAbsent(tabName: string, uniqueColumn: string, data: Input): Promise<{ row: Row; created: boolean }> {
    const value = data[uniqueColumn];
    if (value === undefined || value === null || value === '') throw new Error(`${tabName}.${uniqueColumn} is required for idempotent writes`);
    return this.mutex.run(`idem:${tabName}`, async () => {
      const existing = (await this.readAll(tabName)).find((r) => String(r[uniqueColumn]) === String(value));
      if (existing) return { row: existing, created: false };
      const row = await this.append(tabName, data);
      return { row, created: true };
    });
  }

  /** what a read would show for a cell we just wrote */
  private echo(tab: TabDef, name: string, v: unknown): string | number | null {
    const c = tab.columns.find((x) => x.name === name)!;
    return fromCell(c.type, toCell(c.type, v));
  }

  /** update input columns of an existing row (rejected for append-only tabs and formula columns) */
  async update(tabName: string, key: string, patch: Input): Promise<{ before: Row; after: Row }> {
    const [r] = await this.updateMany(tabName, [{ key, patch }]);
    return r;
  }

  /** several row updates in ONE write call (and one read-back, only for tabs with formulas) */
  async updateMany(tabName: string, items: Array<{ key: string; patch: Input }>): Promise<Array<{ before: Row; after: Row }>> {
    const tab = this.tab(tabName);
    if (tab.appendOnly) throw new ImmutableError(tab.name);
    return this.mutex.run(`update:${tabName}`, async () => {
      const updates = [];
      const befores: Row[] = [];
      for (const { key, patch } of items) {
        const before = await this.getByKey(tabName, key);
        if (!before) throw new NotFoundError(tabName, key);
        if (patch[tab.keyColumn] !== undefined && String(patch[tab.keyColumn]) !== key) throw new ImmutableError(tab.name, 'key column cannot be changed');
        for (const [name, v] of Object.entries(patch)) {
          const ci = tab.columns.findIndex((c) => c.name === name);
          if (ci < 0) throw new Error(`${tab.name}: unknown column ${name}`);
          if (tab.columns[ci].kind === 'formula') throw new Error(`${tab.name}.${name} is a formula column (read-only)`);
          updates.push({ range: `${tab.name}!${colLetter(ci)}${before._row}`, values: [[toCell(tab.columns[ci].type, v)]] });
        }
        befores.push(before);
      }
      await this.gateway.writeRanges(updates);
      this.invalidateFor(tab);
      if (!this.hasFormulas(tab)) {
        // nothing in this tab is calculated, so the outcome is exactly what we wrote
        return items.map(({ patch }, i) => ({ before: befores[i], after: { ...befores[i], ...Object.fromEntries(Object.keys(patch).map((k) => [k, this.echo(tab, k, patch[k])])) } as Row }));
      }
      const out: Array<{ before: Row; after: Row }> = [];
      for (let i = 0; i < items.length; i++) {
        const [grid] = await this.gateway.readRanges([`${tab.name}!A${befores[i]._row}:${this.lastCol(tab)}${befores[i]._row}`]);
        out.push({ before: befores[i], after: this.toRow(tab, grid[0], befores[i]._row) });
      }
      return out;
    });
  }

  invalidate(): void { this.cache.invalidate(); this.used.clear(); }
}
