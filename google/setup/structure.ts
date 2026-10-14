import { ENUMS, SchemaIndex, TabDef, colLetter, formulaColumns, renderGrid, type Cell } from '@nutex/formula-specs';

/**
 * Pure builders for the Google Sheets API requests that create the NUTEX workbook structure.
 * Nothing here talks to Google, so the shape of every request is unit-tested without credentials.
 */
type Req = Record<string, unknown>;

const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });

export const COLORS = {
  inputHeader: '#12324a', formulaHeader: '#0b6b46', systemHeader: '#3b3b46', headerText: '#ffffff', errorFill: '#fde2e1',
  group: {
    System: '#5f6b7a', Security: '#b3261e', HR: '#1a73e8', Attendance: '#0b8043', Leave: '#8e24aa', Payroll: '#e37400', Compliance: '#795548', Reporting: '#00838f',
  } as Record<string, string>,
};

export const sheetIdFor = (idx: SchemaIndex, tab: string): number => idx.tabs.findIndex((t) => t.name === tab) + 1;

export function addSheetRequests(idx: SchemaIndex): Req[] {
  return idx.tabs.map((t, i) => ({
    addSheet: {
      properties: {
        sheetId: i + 1, title: t.name, index: i, tabColor: rgb(COLORS.group[t.group] ?? '#5f6b7a'),
        gridProperties: { rowCount: idx.rowsFor(t) + 1, columnCount: t.columns.length + 1, frozenRowCount: 1, frozenColumnCount: 1 },
      },
    },
  }));
}

const NUMBER_FORMATS: Record<string, { type: string; pattern: string } | undefined> = {
  date: { type: 'DATE', pattern: 'yyyy-mm-dd' }, datetime: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' }, time: { type: 'TIME', pattern: 'hh:mm' },
  money: { type: 'NUMBER', pattern: '#,##0.00' }, percent: { type: 'PERCENT', pattern: '0.00%' },
};

export const WIDTH: Record<string, number> = { id: 170, text: 160, json: 220, enum: 130, yn: 70, number: 100, money: 110, percent: 90, date: 100, datetime: 150, time: 70 };

export function formatRequests(idx: SchemaIndex): Req[] {
  const out: Req[] = [];
  for (const t of idx.tabs) {
    const sheetId = sheetIdFor(idx, t.name);
    const rows = idx.rowsFor(t) + 1;
    t.columns.forEach((c, i) => {
      const bg = c.kind === 'formula' ? COLORS.formulaHeader : t.protection === 'SERVICE_ONLY' ? COLORS.systemHeader : COLORS.inputHeader;
      out.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: { backgroundColor: rgb(bg), textFormat: { bold: true, foregroundColor: rgb(COLORS.headerText) }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' }, note: c.note ?? (c.kind === 'formula' ? 'Formula column: do not edit' : undefined) },
          fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy),note',
        },
      });
      const nf = NUMBER_FORMATS[c.type];
      if (nf) out.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { numberFormat: nf } }, fields: 'userEnteredFormat.numberFormat' } });
      if (c.type === 'text' && c.kind === 'input' && (c.name.endsWith('_code') || c.name === 'phone' || c.name === 'bank_ifsc' || c.name.endsWith('_ref'))) {
        // keep codes like 0012 as text
        out.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } });
      }
      out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: Math.max(WIDTH[c.type] ?? 120, Math.min(220, c.name.length * 8 + 24)) }, fields: 'pixelSize' } });
    });
    const fcols = t.columns.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'formula');
    if (fcols.length) {
      out.push({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: fcols[0].i, endColumnIndex: fcols[fcols.length - 1].i + 1 }],
            booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=ISERROR(${colLetter(fcols[0].i)}2)` }] }, format: { backgroundColor: rgb(COLORS.errorFill) } },
          },
        },
      });
    }
  }
  return out;
}

export function validationRequests(idx: SchemaIndex): Req[] {
  const out: Req[] = [];
  for (const t of idx.tabs) {
    const sheetId = sheetIdFor(idx, t.name);
    const rows = idx.rowsFor(t) + 1;
    t.columns.forEach((c, i) => {
      if (c.kind !== 'input') return;
      const range = { sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: i, endColumnIndex: i + 1 };
      const L = colLetter(i);
      if (c.enum) out.push({ setDataValidation: { range, rule: { condition: { type: 'ONE_OF_LIST', values: ENUMS[c.enum].map((v) => ({ userEnteredValue: v })) }, strict: true, showCustomUi: true, inputMessage: `${c.name}: ${ENUMS[c.enum].join(' / ')}` } } });
      else if (c.ref) {
        const [rt, rc] = c.ref.split('.');
        out.push({ setDataValidation: { range, rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `=${idx.range(rt, rc)}` }] }, strict: false, showCustomUi: true } } });
      } else if (c.type === 'date' || c.type === 'datetime') out.push({ setDataValidation: { range, rule: { condition: { type: 'DATE_IS_VALID' }, strict: false } } });
      else if (c.type === 'number' || c.type === 'money' || c.type === 'percent') out.push({ setDataValidation: { range, rule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=OR(ISBLANK(${L}2),ISNUMBER(${L}2))` }] }, strict: false } } });
    });
  }
  return out;
}

export function namedRangeRequests(idx: SchemaIndex): Req[] {
  return idx.tabs.map((t) => {
    const kc = idx.colIndex(t, t.keyColumn);
    return { addNamedRange: { namedRange: { name: `${t.name}_KEYS`, range: { sheetId: sheetIdFor(idx, t.name), startRowIndex: 1, endRowIndex: idx.rowsFor(t) + 1, startColumnIndex: kc, endColumnIndex: kc + 1 } } } };
  });
}

export interface ProtectionEditors { service: string; admins: string[] }

export function protectionRequests(idx: SchemaIndex, ed: ProtectionEditors): Req[] {
  const out: Req[] = [];
  for (const t of idx.tabs) {
    const sheetId = sheetIdFor(idx, t.name);
    const rows = idx.rowsFor(t) + 1;
    const users = [...new Set([ed.service, ...ed.admins].filter(Boolean))];
    const editors = { users, domainUsersCanEdit: false };
    if (t.protection === 'SERVICE_ONLY') {
      out.push({ addProtectedRange: { protectedRange: { range: { sheetId }, description: `${t.name}: whole tab locked${t.appendOnly ? ' (append-only)' : ''}`, warningOnly: false, editors } } });
      continue;
    }
    out.push({ addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, description: `${t.name}: header row`, warningOnly: false, editors } } });
    const f = formulaColumns(t);
    if (f.length) {
      const first = t.columns.findIndex((c) => c.kind === 'formula');
      out.push({ addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: first, endColumnIndex: first + f.length }, description: `${t.name}: formula block (${f[0].name}..${f[f.length - 1].name})`, warningOnly: false, editors } } });
    }
  }
  return out;
}

export interface ValueUpdate { range: string; values: Cell[][] }

/**
 * Header row (all columns) + formula block rows, chunked so a single values.batchUpdate stays small.
 * Input cells are left untouched. Tabs with fixed rows (DASHBOARD_DATA) are written in full.
 */
export function valueUpdates(idx: SchemaIndex, chunkCells = 40_000): ValueUpdate[] {
  const out: ValueUpdate[] = [];
  for (const t of idx.tabs) {
    if (t.name === 'LOOKUPS' || t.name === 'README') { out.push({ range: `${t.name}!A1:${colLetter(t.columns.length - 1)}1`, values: [t.columns.map((c) => c.name)] }); continue; }
    const grid = renderGrid(idx, t);
    out.push({ range: `${t.name}!A1:${colLetter(t.columns.length - 1)}1`, values: [grid[0]] });
    const fcols = t.columns.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'formula');
    if (!fcols.length) continue;
    const first = t.fixedRows ? 0 : fcols[0].i;
    const width = t.columns.length - first;
    const rowsPerChunk = Math.max(1, Math.floor(chunkCells / width));
    for (let r = 1; r < grid.length; r += rowsPerChunk) {
      const slice = grid.slice(r, r + rowsPerChunk).map((line) => line.slice(first).map((v) => (v === null ? '' : v)));
      out.push({ range: `${t.name}!${colLetter(first)}${r + 1}:${colLetter(t.columns.length - 1)}${r + slice.length}`, values: slice as Cell[][] });
    }
  }
  return out;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function describeTab(t: TabDef, idx: SchemaIndex) {
  return { name: t.name, rows: idx.rowsFor(t), columns: t.columns.length, formulas: formulaColumns(t).length };
}
