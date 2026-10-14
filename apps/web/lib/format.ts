/** pure helpers (unit tested in apps/web/tests) */

export const inr = (v: unknown): string => Number(v ?? 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const num = (v: unknown, d = 2): string => Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: d });

export const dateOnly = (s: unknown): string => (s ? String(s).slice(0, 10) : '');
export const timeOnly = (s: unknown): string => (s && String(s).length >= 16 ? String(s).slice(11, 16) : '');
export const minutesToHm = (m: unknown): string => {
  const n = Math.round(Number(m ?? 0));
  return n ? `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, '0')}m` : '-';
};

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const TONES: Record<string, Tone> = {
  PRESENT: 'ok', APPROVED: 'ok', ACTIVE: 'ok', ENROLLED: 'ok', VERIFIED: 'ok', PAID: 'ok', LOCKED: 'ok', SENT: 'ok', PASSED: 'ok', RESOLVED: 'ok', OK: 'ok', WFH_OD: 'ok', YES: 'ok',
  PENDING: 'warn', HALF_DAY: 'warn', REVIEW: 'warn', PROCESSING: 'warn', QUEUED: 'warn', NOTICE: 'warn', OPEN: 'info', DRAFT: 'info', WAIVED: 'neutral', HALF_LEAVE: 'warn',
  ABSENT: 'bad', REJECTED: 'bad', FAILED: 'bad', MISSING_PUNCH: 'bad', DISABLED: 'bad', DELETED: 'bad', CANCELLED: 'neutral', EXITED: 'neutral', UNPAID_LEAVE: 'bad', NO: 'bad', ERROR: 'bad',
  LEAVE: 'info', HOLIDAY: 'info', WEEKOFF: 'neutral', HOLIDAY_WORK: 'ok', WEEKOFF_WORK: 'ok', NA: 'neutral', INACTIVE: 'neutral', ARCHIVED: 'neutral',
};
export const toneOf = (s: unknown): Tone => TONES[String(s ?? '').toUpperCase()] ?? 'neutral';
export const label = (s: unknown): string => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** CSV with spreadsheet formula-injection neutralised */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, unknown>>): string {
  return [columns.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','))].join('\n');
}

export function download(name: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isoDay = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const monthRange = (ym: string): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
};
