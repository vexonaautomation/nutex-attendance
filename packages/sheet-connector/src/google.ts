import { google, type sheets_v4 } from 'googleapis';
import { RangeUpdate, SheetsGateway } from './gateway';
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

  constructor(private spreadsheetId: string, auth: ReturnType<typeof createGoogleAuth>, private retry: RetryOptions = {}) {
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
}

function colWidth(a: string, b: string): number {
  const idx = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return idx(b) - idx(a) + 1;
}
