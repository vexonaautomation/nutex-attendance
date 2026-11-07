import type { CellValue } from './serial';

export interface RangeUpdate { range: string; values: CellValue[][] }

/**
 * Minimal transport over a spreadsheet. Two implementations:
 *  - GoogleSheetsGateway  (production, real Google Sheets API v4)
 *  - EmulatorGateway      (tests / offline dev only; evaluates the same formulas with HyperFormula)
 */
export interface SheetsGateway {
  readonly kind: 'google' | 'emulator';
  /** batch read, unformatted values, dates as serial numbers. Errors come back as '#REF!' style strings. */
  readRanges(ranges: string[]): Promise<CellValue[][][]>;
  /** batch write with RAW semantics (never evaluates formulas) */
  writeRanges(updates: RangeUpdate[]): Promise<void>;
  /**
   * Extra tabs beyond the fixed schema (archive tabs such as one monthly attendance grid per month). Optional: only the
   * monthly-grid feature uses them, and it reports a clear error when a gateway cannot add a tab.
   */
  listSheets?(): Promise<SheetInfo[]>;
  addSheet?(title: string, rows: number, cols: number): Promise<SheetInfo>;
  /** colours / frozen header for a monthly grid tab (cosmetic; the emulator ignores it) */
  styleGridSheet?(sheetId: number, spec: GridStyle): Promise<void>;
}

export interface SheetInfo { title: string; sheetId: number }
export interface GridStyle {
  rows: number; cols: number;
  /** 0-based first and last column index that holds a day code (P / A / W ...) and the first data row (0-based) */
  dayCols: [number, number]; firstDataRow: number; headerRow: number;
}

export interface A1Range { sheet: string; c1: number; r1: number; c2: number; r2: number }

export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** parse 'TAB!A2:C10' or 'TAB!A5' (bounded ranges only) */
export function parseA1(range: string): A1Range {
  const m = /^'?([^'!]+)'?!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) throw new Error(`Unsupported range "${range}"`);
  const c1 = colToIndex(m[2]);
  const r1 = +m[3];
  return { sheet: m[1], c1, r1, c2: m[4] ? colToIndex(m[4]) : c1, r2: m[5] ? +m[5] : r1 };
}
