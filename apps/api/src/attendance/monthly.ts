import { GoogleSheetsGateway, type SheetInfo } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, badRequest, conflict, forbidden, str, toLocalWallClock } from '../common/core';
import { scopedEmployeeIds } from '../auth/auth';
import { scaffoldAttendanceDaily } from '../common/scaffold';

/**
 * Monthly attendance grid: one row per employee, one column per day (P / A / W ...), plus the month totals.
 *
 * The day codes and the OT minutes are the sheet's own results (ATTENDANCE_DAILY.status / ot_min_*): this file only lays
 * them out as a grid and adds them up for display, it applies no attendance rule. When a month is over, the grid is
 * frozen into its own tab of the workbook ("Nov 2026"), the way PAYROLL_SNAPSHOT freezes a locked payroll period.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TAB_RE = /^([A-Z][a-z]{2}) (\d{4})$/;

export const LEGEND: Array<{ code: string; label: string }> = [
  { code: 'P', label: 'Present' }, { code: 'HD', label: 'Half day' }, { code: 'A', label: 'Absent' }, { code: 'L', label: 'Paid leave' },
  { code: 'UL', label: 'Unpaid leave' }, { code: 'W', label: 'Week off' }, { code: 'WP', label: 'Worked on week off' }, { code: 'H', label: 'Holiday' },
  { code: 'HP', label: 'Worked on holiday' }, { code: 'WFH', label: 'Work from home / on duty' }, { code: 'M', label: 'Missing punch' }, { code: 'IN', label: 'Checked in, not out yet' },
];

/** the sheet's daily status, as the short code shown in the grid */
const CODE: Record<string, string> = {
  PRESENT: 'P', HALF_DAY: 'HD', ABSENT: 'A', LEAVE: 'L', UNPAID_LEAVE: 'UL', WEEKOFF: 'W', WEEKOFF_WORK: 'WP', HOLIDAY: 'H', HOLIDAY_WORK: 'HP',
  WFH_OD: 'WFH', MISSING_PUNCH: 'M', IN_PROGRESS: 'IN',
};

export interface GridTotals { present: number; absent: number; leave: number; totalDays: number; weekOff: number; overtimeHours: number }
export interface GridRow { sNo: number; employeeId: string; employeeCode: string; name: string; cells: string[]; totals: GridTotals }
export interface MonthGrid {
  year: number; month: number; key: string; title: string; monthName: string; days: number;
  /** 'sheet' = the frozen copy saved in the workbook, 'live' = built now from the daily results */
  source: 'live' | 'sheet'; complete: boolean; savedAt: string | null; rows: GridRow[];
}
export interface MonthInfo { key: string; title: string; year: number; month: number; monthName: string; status: 'open' | 'complete' | 'saved'; sheetId: number | null; url: string | null }

const pad = (n: number) => String(n).padStart(2, '0');
export const monthTitle = (year: number, month: number) => `${MONTHS[month - 1].slice(0, 3)} ${year}`;
const monthKey = (year: number, month: number) => `${year}-${pad(month)}`;
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function parseTitle(title: string): { year: number; month: number } | null {
  const m = TAB_RE.exec(title);
  if (!m) return null;
  const i = MONTHS.findIndex((x) => x.startsWith(m[1]));
  return i < 0 ? null : { year: Number(m[2]), month: i + 1 };
}

const presence = (code: string) => (code === 'P' || code === 'WP' || code === 'HP' || code === 'WFH' ? 1 : code === 'HD' ? 0.5 : 0);

function totalsOf(cells: string[], days: number, otMinutes: number): GridTotals {
  let present = 0, absent = 0, leave = 0, weekOff = 0;
  for (const c of cells) {
    present += presence(c);
    if (c === 'A') absent++;
    if (c === 'L' || c === 'UL') leave++;
    if (c === 'W' || c === 'WP') weekOff++;
  }
  return { present, absent, leave, totalDays: days, weekOff, overtimeHours: Math.round(otMinutes / 6) / 10 };
}

/** local company date and time right now */
function nowLocal(ctx: AppContext) { return toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE); }

/** a month is complete once the new month has started and the day-boundary hours of its last night have passed */
async function isComplete(ctx: AppContext, year: number, month: number): Promise<boolean> {
  const cfg = await ctx.systemConfig();
  const boundary = cfg.num('DAY_BOUNDARY_HOURS', 0);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  const hours = Math.floor(boundary) + 1; // one extra hour so the last late punches are in
  return nowLocal(ctx) >= `${next}T${pad(Math.min(hours, 23))}:00:00`;
}

/** rows for the employees in `ids`, built from ATTENDANCE_DAILY */
async function buildLive(ctx: AppContext, ids: Set<string> | 'ALL', year: number, month: number): Promise<MonthGrid> {
  const days = daysIn(year, month);
  const first = `${monthKey(year, month)}-01`;
  const last = `${monthKey(year, month)}-${pad(days)}`;
  const daily = await ctx.repo.find('ATTENDANCE_DAILY', (r) => {
    const d = str(r.work_date);
    return d >= first && d <= last && (ids === 'ALL' || ids.has(str(r.employee_id)));
  });
  const byEmp = new Map<string, Array<(typeof daily)[number]>>();
  for (const r of daily) {
    const k = str(r.employee_id);
    if (!byEmp.has(k)) byEmp.set(k, []);
    byEmp.get(k)!.push(r);
  }
  const emps = await ctx.repo.readAll('EMPLOYEES');
  const people = emps.filter((e) => byEmp.has(str(e.employee_id)))
    .sort((a, b) => str(a.employee_code).localeCompare(str(b.employee_code), undefined, { numeric: true }) || str(a.employee_id).localeCompare(str(b.employee_id)));
  const rows: GridRow[] = [];
  for (const e of people) {
    const cells = Array<string>(days).fill('');
    let ot = 0;
    for (const r of byEmp.get(str(e.employee_id))!) {
      const day = Number(str(r.work_date).slice(8, 10));
      if (day >= 1 && day <= days) cells[day - 1] = CODE[str(r.status)] ?? '';
      ot += Number(r.ot_min_regular ?? 0) + Number(r.ot_min_offday ?? 0);
    }
    if (cells.every((c) => c === '')) continue; // not in service at any time this month
    const name = str(e.full_name) || `${str(e.first_name)} ${str(e.last_name)}`.trim() || str(e.employee_id);
    rows.push({ sNo: rows.length + 1, employeeId: str(e.employee_id), employeeCode: str(e.employee_code) || str(e.employee_id), name, cells, totals: totalsOf(cells, days, ot) });
  }
  return { year, month, key: monthKey(year, month), title: monthTitle(year, month), monthName: MONTHS[month - 1], days, source: 'live', complete: await isComplete(ctx, year, month), savedAt: null, rows };
}

// ------------------------------------------------------------------ the saved tab

const HEADER_ROW = 4; // 1-based row of the column titles
const TOTAL_HEADS = ['Total Present', 'Total Absent', 'Total Leave Days', 'Total Days', 'Total Week Off', 'Over Time (hrs)'];

function toValues(g: MonthGrid, savedAt: string): Array<Array<string | number | null>> {
  const width = 3 + g.days + TOTAL_HEADS.length;
  const fill = (r: Array<string | number | null>) => [...r, ...Array<null>(width - r.length).fill(null)];
  const out: Array<Array<string | number | null>> = [
    fill(['MONTHLY ATTENDANCE GRID']),
    fill(['Month', g.monthName, g.year]),
    fill([`Saved ${savedAt.replace('T', ' ')} (company time). A frozen copy of the month: later corrections do not change this tab.`]),
    fill(['S.No', 'Employee Name', 'Emp ID', ...Array.from({ length: g.days }, (_, i) => i + 1), ...TOTAL_HEADS]),
  ];
  for (const r of g.rows) {
    out.push(fill([r.sNo, r.name, r.employeeCode, ...r.cells.map((c) => c || null),
      r.totals.present, r.totals.absent, r.totals.leave, r.totals.totalDays, r.totals.weekOff, r.totals.overtimeHours]));
  }
  out.push(fill([]));
  out.push(fill(['Legend', LEGEND.map((l) => `${l.code} = ${l.label}`).join('   ')]));
  return out;
}

async function readSaved(ctx: AppContext, sheet: SheetInfo, year: number, month: number): Promise<MonthGrid | null> {
  const days = daysIn(year, month);
  const width = 3 + days + TOTAL_HEADS.length;
  const [grid] = await ctx.repo.gateway.readRanges([`'${sheet.title}'!A1:${colLetter(width - 1)}1000`]);
  const rows: GridRow[] = [];
  for (let i = HEADER_ROW; i < grid.length; i++) {
    const line = grid[i];
    if (typeof line[0] !== 'number') break; // blank row before the legend
    const cells = line.slice(3, 3 + days).map((c) => (c === null || c === undefined ? '' : String(c)));
    const t = line.slice(3 + days).map((n) => Number(n ?? 0));
    rows.push({ sNo: line[0], employeeId: str(line[2]), employeeCode: str(line[2]), name: str(line[1]), cells,
      totals: { present: t[0], absent: t[1], leave: t[2], totalDays: t[3], weekOff: t[4], overtimeHours: t[5] } });
  }
  const savedAt = /^Saved (\S+ \S+)/.exec(str(grid[2]?.[0]))?.[1]?.replace(' ', 'T') ?? null;
  return { year, month, key: monthKey(year, month), title: sheet.title, monthName: MONTHS[month - 1], days, source: 'sheet', complete: true, savedAt, rows };
}

// ------------------------------------------------------------------ public API

function sheetUrl(ctx: AppContext, sheetId: number): string | null {
  const gw = ctx.repo.gateway;
  return gw instanceof GoogleSheetsGateway ? `https://docs.google.com/spreadsheets/d/${gw.spreadsheetId}/edit#gid=${sheetId}` : null;
}

/** the last six months and every saved month, newest first */
export async function listMonths(ctx: AppContext, actor: Actor): Promise<MonthInfo[]> {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'attendance', 'read');
  const canSee = ids === 'ALL';
  void autoCloseMonths(ctx).catch(() => undefined); // never block (or fail) the page; the timer retries
  const saved = new Map<string, SheetInfo>();
  const gw = ctx.repo.gateway;
  if (canSee && gw.listSheets) for (const s of await gw.listSheets()) { const p = parseTitle(s.title); if (p) saved.set(monthKey(p.year, p.month), s); }
  const today = nowLocal(ctx);
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const keys = new Map<string, { year: number; month: number }>();
  for (let i = 0; i < 6; i++) { keys.set(monthKey(y, m), { year: y, month: m }); m--; if (m === 0) { m = 12; y--; } }
  for (const k of saved.keys()) keys.set(k, { year: Number(k.slice(0, 4)), month: Number(k.slice(5, 7)) });
  const out: MonthInfo[] = [];
  for (const [key, { year, month }] of [...keys].sort((a, b) => b[0].localeCompare(a[0]))) {
    const s = saved.get(key);
    const complete = await isComplete(ctx, year, month);
    out.push({ key, title: monthTitle(year, month), year, month, monthName: MONTHS[month - 1], status: s ? 'saved' : complete ? 'complete' : 'open', sheetId: s?.sheetId ?? null, url: s ? sheetUrl(ctx, s.sheetId) : null });
  }
  return out;
}

const filledAt = new Map<string, { at: number; to: string }>();

/**
 * Days nobody punched on have no row yet, so the sheet cannot say absent / week off / holiday for them. When someone with company-wide
 * access opens a month, create the missing employee x day rows up to today (the same rows payroll creates; the sheet formulas fill them).
 */
async function ensureRows(ctx: AppContext, actor: Actor, year: number, month: number): Promise<void> {
  const today = nowLocal(ctx).slice(0, 10);
  const first = `${monthKey(year, month)}-01`;
  if (first > today) return;
  const to = [`${monthKey(year, month)}-${pad(daysIn(year, month))}`, today].sort()[0];
  const k = monthKey(year, month);
  const prev = filledAt.get(k);
  if (prev && prev.to === to && Date.now() - prev.at < 600_000) return;
  filledAt.set(k, { at: Date.now(), to });
  try {
    await scaffoldAttendanceDaily(ctx.repo, first, to, { companyId: actor.user.companyId, actor: actor.user.userId, requestId: actor.requestId, now: nowLocal(ctx) });
  } catch { /* out of room in ATTENDANCE_DAILY: show what exists */ }
}

/** the frozen tab when there is one (and the caller may see everybody), otherwise a live grid within the caller's scope */
export async function getMonth(ctx: AppContext, actor: Actor, year: number, month: number): Promise<MonthGrid> {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'attendance', 'read');
  if (ids === 'ALL' && ctx.repo.gateway.listSheets) {
    const sheet = (await ctx.repo.gateway.listSheets()).find((s) => s.title === monthTitle(year, month));
    if (sheet) { const g = await readSaved(ctx, sheet, year, month); if (g) return g; }
  }
  if (ids === 'ALL') await ensureRows(ctx, actor, year, month);
  return buildLive(ctx, ids, year, month);
}

const inflight = new Map<string, Promise<MonthInfo>>();

/** freeze a finished month into its own tab. `actor` null = the automatic monthly job. */
export function saveMonth(ctx: AppContext, actor: Actor | null, year: number, month: number): Promise<MonthInfo> {
  const key = monthKey(year, month);
  const running = inflight.get(key);
  if (running) return running;
  const job = doSave(ctx, actor, year, month).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function doSave(ctx: AppContext, actor: Actor | null, year: number, month: number): Promise<MonthInfo> {
  const gw = ctx.repo.gateway;
  if (!gw.addSheet || !gw.listSheets) throw new HttpError(501, 'NOT_SUPPORTED', 'This backend cannot keep monthly tabs');
  if (actor) {
    const ids = await scopedEmployeeIds(ctx, actor.user, 'attendance', 'read');
    if (ids !== 'ALL') throw forbidden('Saving a month needs company-wide attendance access');
  }
  if (!(await isComplete(ctx, year, month))) throw new HttpError(422, 'MONTH_NOT_COMPLETE', `${MONTHS[month - 1]} ${year} is not over yet`);
  const title = monthTitle(year, month);
  if ((await gw.listSheets()).some((s) => s.title === title)) throw conflict(`${title} is already saved`, 'ALREADY_SAVED');

  // make sure every employee has a row for every day (days without a punch then show as absent / week off / holiday by the sheet's own rules)
  const first = `${monthKey(year, month)}-01`;
  const last = `${monthKey(year, month)}-${pad(daysIn(year, month))}`;
  const stamp = nowLocal(ctx);
  try {
    const company = str((await ctx.repo.readAll('EMPLOYEES'))[0]?.company_id);
    await scaffoldAttendanceDaily(ctx.repo, first, last, { companyId: company, actor: actor?.user.userId ?? 'SYSTEM', requestId: actor?.requestId ?? 'monthly-close', now: stamp });
  } catch { /* out of room in ATTENDANCE_DAILY: keep the rows that exist */ }

  const grid = await buildLive(ctx, 'ALL', year, month);
  const values = toValues(grid, stamp);
  const width = values[0].length;
  const sheet = await gw.addSheet(title, values.length + 5, width);
  await gw.writeRanges([{ range: `'${title}'!A1:${colLetter(width - 1)}${values.length}`, values }]);
  await gw.styleGridSheet?.(sheet.sheetId, { rows: values.length + 5, cols: width, dayCols: [3, 3 + grid.days - 1], firstDataRow: HEADER_ROW, headerRow: HEADER_ROW - 1 });
  await ctx.audit.write(actor, { action: 'ATTENDANCE_MONTH_SAVED', entityType: 'ATTENDANCE_MONTH', entityId: title, after: { employees: grid.rows.length, days: grid.days, by: actor ? 'user' : 'automatic job' } });
  return { key: monthKey(year, month), title, year, month, monthName: MONTHS[month - 1], status: 'saved', sheetId: sheet.sheetId, url: sheetUrl(ctx, sheet.sheetId) };
}

let lastFailure = 0;

/** save last month if it is over and has no tab yet (runs on a timer, and whenever the month list is opened) */
export async function autoCloseMonths(ctx: AppContext): Promise<MonthInfo | null> {
  if (!ctx.repo.gateway.addSheet || Date.now() - lastFailure < 30 * 60_000) return null;
  const today = nowLocal(ctx);
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7)) - 1;
  if (month === 0) { month = 12; year--; }
  if (!(await isComplete(ctx, year, month))) return null;
  if ((await ctx.repo.gateway.listSheets!()).some((s) => s.title === monthTitle(year, month))) return null;
  try {
    return await saveMonth(ctx, null, year, month);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'ALREADY_SAVED') return null;
    lastFailure = Date.now();
    console.error(`[nutex] monthly attendance tab for ${monthTitle(year, month)} failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export function parseYearMonth(year: unknown, month: unknown): { year: number; month: number } {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) throw badRequest('year and month are required, for example year=2026&month=11');
  return { year: y, month: m };
}
