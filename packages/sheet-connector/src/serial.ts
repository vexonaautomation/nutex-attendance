import type { ColType } from '@nutex/formula-specs';

/** Google Sheets / Excel serial epoch (1899-12-30) */
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** ISO date 'YYYY-MM-DD' -> serial day number */
export function dateToSerial(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid date "${iso}" (expected YYYY-MM-DD)`);
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH_MS) / DAY_MS);
}

/** company-local wall clock 'YYYY-MM-DDTHH:mm[:ss]' (no timezone) -> serial */
export function dateTimeToSerial(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new Error(`Invalid datetime "${local}" (expected YYYY-MM-DDTHH:mm:ss)`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return (ms - EPOCH_MS) / DAY_MS;
}

export function timeToSerial(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:mm)`);
  return (+m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)) / 86400;
}

export function serialToDate(serial: number): string {
  return new Date(EPOCH_MS + Math.floor(serial + 1e-9) * DAY_MS).toISOString().slice(0, 10);
}

export function serialToDateTime(serial: number): string {
  const ms = Math.round((serial * DAY_MS) / 1000) * 1000;
  return new Date(EPOCH_MS + ms).toISOString().slice(0, 19);
}

export function serialToTime(serial: number): string {
  const total = Math.round((serial - Math.floor(serial)) * 86400);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type CellValue = string | number | boolean | null;

/** app value -> cell value written with valueInputOption RAW (RAW never evaluates "=..." strings: formula-injection safe) */
export function toCell(type: ColType, v: unknown): CellValue {
  if (v === undefined || v === null || v === '') return null;
  switch (type) {
    case 'date': return typeof v === 'number' ? v : dateToSerial(String(v).slice(0, 10));
    case 'datetime': return typeof v === 'number' ? v : dateTimeToSerial(String(v));
    case 'time': return typeof v === 'number' ? v : timeToSerial(String(v));
    case 'number': case 'money': case 'percent': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw new Error(`Invalid number "${String(v)}"`);
      return n;
    }
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v);
    default: return typeof v === 'number' ? v : String(v);
  }
}

export function fromCell(type: ColType, v: CellValue | undefined): string | number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && v.startsWith('#')) return v; // sheet error surfaced verbatim
  // formulas such as MINIFS / N() return 0 for "no value"; serial 0 (1899-12-30) is never real business data
  if (v === 0 && (type === 'date' || type === 'datetime')) return null;
  switch (type) {
    case 'date': return typeof v === 'number' ? serialToDate(v) : String(v);
    case 'datetime': return typeof v === 'number' ? serialToDateTime(v) : String(v);
    case 'time': return typeof v === 'number' ? serialToTime(v) : String(v);
    case 'number': case 'money': case 'percent': return typeof v === 'number' ? v : Number(v);
    default: return typeof v === 'boolean' ? String(v) : v;
  }
}
