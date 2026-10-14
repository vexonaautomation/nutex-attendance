import { HyperFormula, type RawCellContent } from 'hyperformula';
import { SchemaIndex, renderGrid } from '@nutex/formula-specs';
import { RangeUpdate, SheetsGateway, parseA1 } from './gateway';
import type { CellValue } from './serial';

/**
 * Local spreadsheet emulator backed by HyperFormula. It loads the exact grid the Google setup script creates
 * (headers + pre-filled formulas) and recalculates like the real sheet. It exists so that the SAME formulas can be
 * verified in CI and used for offline development. It is not a database: refuses to start when NODE_ENV=production.
 */
export class EmulatorGateway implements SheetsGateway {
  readonly kind = 'emulator' as const;
  readonly hf: HyperFormula;
  readonly sheetIds = new Map<string, number>();
  writes = 0;
  reads = 0;

  constructor(public readonly idx: SchemaIndex) {
    if (process.env.NODE_ENV === 'production') throw new Error('EmulatorGateway must never run in production. Configure Google credentials.');
    const sheets: Record<string, RawCellContent[][]> = {};
    for (const t of idx.tabs) sheets[t.name] = renderGrid(idx, t) as RawCellContent[][];
    this.hf = HyperFormula.buildFromSheets(sheets, {
      licenseKey: 'gpl-v3', useColumnIndex: true, useArrayArithmetic: true, matchWholeCell: true, caseSensitive: false, evaluateNullToZero: true,
    });
    for (const t of idx.tabs) this.sheetIds.set(t.name, this.hf.getSheetId(t.name)!);
  }

  private sheet(name: string): number {
    const id = this.sheetIds.get(name);
    if (id === undefined) throw new Error(`Unknown sheet ${name}`);
    return id;
  }

  async readRanges(ranges: string[]): Promise<CellValue[][][]> {
    this.reads++;
    return ranges.map((r) => {
      const a = parseA1(r);
      const sid = this.sheet(a.sheet);
      const out: CellValue[][] = [];
      for (let row = a.r1; row <= a.r2; row++) {
        const line: CellValue[] = [];
        for (let c = a.c1; c <= a.c2; c++) {
          const v = this.hf.getCellValue({ sheet: sid, row: row - 1, col: c });
          if (v === null || v === undefined) line.push(null);
          else if (typeof v === 'object' && 'value' in (v as object)) line.push((v as { value: string }).value);
          else line.push(v as CellValue);
        }
        out.push(line);
      }
      return out;
    });
  }

  async writeRanges(updates: RangeUpdate[]): Promise<void> {
    this.writes++;
    this.hf.batch(() => {
      for (const u of updates) {
        const a = parseA1(u.range);
        const sid = this.sheet(a.sheet);
        u.values.forEach((line, ri) =>
          line.forEach((v, ci) => {
            // RAW semantics: text that starts with "=" must stay text
            const content = typeof v === 'string' && v.startsWith('=') ? `'${v}` : v;
            this.hf.setCellContents({ sheet: sid, row: a.r1 - 1 + ri, col: a.c1 + ci }, [[content === null ? null : (content as RawCellContent)]]);
          }));
      }
    });
  }

  /** value of any cell incl. formula columns (test helper) */
  cell(sheet: string, a1: string): CellValue {
    const [c, r] = /^([A-Z]+)(\d+)$/.exec(a1)!.slice(1);
    const p = parseA1(`${sheet}!${c}${r}`);
    const v = this.hf.getCellValue({ sheet: this.sheet(sheet), row: p.r1 - 1, col: p.c1 });
    return (v && typeof v === 'object' ? (v as { value: string }).value : v) as CellValue;
  }
}
