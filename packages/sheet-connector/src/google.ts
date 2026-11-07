import { google, type sheets_v4 } from 'googleapis';
import { GridStyle, RangeUpdate, SheetInfo, SheetsGateway } from './gateway';
import { RetryOptions, withRetry } from './infra';
import type { CellValue } from './serial';

export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  // drive.file = only files this app/service account created or that were explicitly shared with it (least privilege)
  'https://www.googleapis.com/auth/drive.file',
];

export interface GoogleAuthConfig {
  /** path to a service-account JSON key file */
  keyFile?: string;
  /** base64 (or raw) JSON credentials, for secret managers */
  credentialsJson?: string;
  scopes?: string[];
}

export function createGoogleAuth(cfg: GoogleAuthConfig) {
  const scopes = cfg.scopes ?? SHEETS_SCOPES;
  if (cfg.credentialsJson) {
    const raw = cfg.credentialsJson.trim().startsWith('{') ? cfg.credentialsJson : Buffer.from(cfg.credentialsJson, 'base64').toString('utf8');
    return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes });
  }
  if (cfg.keyFile) return new google.auth.GoogleAuth({ keyFile: cfg.keyFile, scopes });
  throw new Error('Google credentials missing: set GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON (see SETUP_GOOGLE.md)');
}

export class GoogleSheetsGateway implements SheetsGateway {
  readonly kind = 'google' as const;
  readonly sheets: sheets_v4.Sheets;
  /** counters exposed for quota monitoring */
  stats = { reads: 0, writes: 0, retries: 0 };

  constructor(readonly spreadsheetId: string, auth: ReturnType<typeof createGoogleAuth>, private retry: RetryOptions = {}) {
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  private opts(): RetryOptions {
    return { ...this.retry, onRetry: (i) => { this.stats.retries++; this.retry.onRetry?.(i); } };
  }

  async readRanges(ranges: string[]): Promise<CellValue[][][]> {
    this.stats.reads++;
    const res = await withRetry(
      () => this.sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId, ranges,
        valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS',
      }),
      this.opts(),
    );
    return (res.data.valueRanges ?? []).map((vr, i) => {
      const rows = (vr.values ?? []) as CellValue[][];
      // Sheets trims trailing empties; pad to the requested rectangle
      const m = /!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ranges[i]);
      if (!m) return rows;
      const width = m[3] ? colWidth(m[1], m[3]) : 1;
      const height = m[4] ? +m[4] - +m[2] + 1 : 1;
      const out: CellValue[][] = [];
      for (let r = 0; r < height; r++) {
        const src = rows[r] ?? [];
        const line: CellValue[] = [];
        for (let c = 0; c < width; c++) line.push(src[c] === undefined || src[c] === '' ? null : src[c]);
        out.push(line);
      }
      return out;
    });
  }

  async writeRanges(updates: RangeUpdate[]): Promise<void> {
    if (!updates.length) return;
    this.stats.writes++;
    await withRetry(
      () => this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW', // RAW: "=..." typed by a user is stored as text, never evaluated
          data: updates.map((u) => ({ range: u.range, majorDimension: 'ROWS', values: u.values.map((r) => r.map((v) => (v === null ? '' : v))) })),
        },
      }),
      this.opts(),
    );
  }

  async listSheets(): Promise<SheetInfo[]> {
    this.stats.reads++;
    const res = await withRetry(() => this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(sheetId,title)' }), this.opts());
    return (res.data.sheets ?? []).map((s) => ({ title: s.properties?.title ?? '', sheetId: s.properties?.sheetId ?? 0 }));
  }

  async addSheet(title: string, rows: number, cols: number): Promise<SheetInfo> {
    this.stats.writes++;
    const res = await withRetry(
      () => this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: Math.max(rows, 10), columnCount: Math.max(cols, 5) } } } }] },
      }),
      this.opts(),
    );
    const p = res.data.replies?.[0]?.addSheet?.properties;
    return { title: p?.title ?? title, sheetId: p?.sheetId ?? 0 };
  }

  async styleGridSheet(sheetId: number, spec: GridStyle): Promise<void> {
    this.stats.writes++;
    const [d1, d2] = spec.dayCols;
    const rng = (r1: number, r2: number, c1: number, c2: number) => ({ sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
    const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
    const rule = (text: string, bg: string, fg: string) => ({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [rng(spec.firstDataRow, spec.rows, d1, d2 + 1)],
          booleanRule: { condition: { type: 'TEXT_EQ' as const, values: [{ userEnteredValue: text }] }, format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg) } } },
        },
      },
    });
    const requests: sheets_v4.Schema$Request[] = [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: spec.headerRow + 1, frozenColumnCount: 3 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
      { repeatCell: { range: rng(0, 1, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }, fields: 'userEnteredFormat.textFormat' } },
      { repeatCell: { range: rng(spec.headerRow, spec.headerRow + 1, 0, spec.cols), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: rgb('#e8eefc'), horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)' } },
      { repeatCell: { range: rng(spec.firstDataRow, spec.rows, d1, d2 + 1), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat.horizontalAlignment' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 60 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 80 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: d1, endIndex: d2 + 1 }, properties: { pixelSize: 34 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: d2 + 1, endIndex: spec.cols }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
      // colours (first rule added ends up on top, so the order below is the reverse of the priority)
      rule('M', '#e0e0e0', '#444444'), rule('WFH', '#bfe9e4', '#0b5b53'), rule('HD', '#fbe9a8', '#7a5b00'), rule('UL', '#c9dcf8', '#1d4e9c'),
      rule('L', '#c9dcf8', '#1d4e9c'), rule('H', '#d9c7f5', '#4a2a8a'), rule('HP', '#c6efce', '#1e6b34'), rule('WP', '#c6efce', '#1e6b34'),
      rule('W', '#f6b88a', '#6b3a10'), rule('A', '#f8c9c9', '#9b1c1c'), rule('P', '#c6efce', '#1e6b34'),
    ];
    await withRetry(() => this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }), this.opts());
  }
}

function colWidth(a: string, b: string): number {
  const idx = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return idx(b) - idx(a) + 1;
}
