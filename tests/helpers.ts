import { buildTestSchema, type SchemaIndex } from '@nutex/formula-specs';
import { EmulatorGateway, SheetRepository, type Row } from '@nutex/sheet-connector';
import { applySeed } from '../google/setup/apply-seed';
import { scaffoldAttendanceDaily, scaffoldPayrollPeriod } from '../apps/api/src/common/scaffold';
import { IDS } from '../google/setup/seed-data';

export { IDS };
export const meta = { companyId: IDS.company, actor: 'test', requestId: 'test', now: '2026-09-01T00:00:00' };

export interface Env { idx: SchemaIndex; gw: EmulatorGateway; repo: SheetRepository; seq: () => number }

export async function makeEnv(rows = 60, big: Record<string, number> = {}): Promise<Env> {
  process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'test' : process.env.NODE_ENV;
  const idx = buildTestSchema(rows, big);
  const gw = new EmulatorGateway(idx);
  const repo = new SheetRepository(gw, idx, { cacheTtlMs: 0, configCacheTtlMs: 0 });
  await applySeed(repo, idx, {});
  let n = 0;
  return { idx, gw, repo, seq: () => ++n };
}

export async function punch(env: Env, emp: string, type: 'IN' | 'OUT', local: string, extra: Record<string, unknown> = {}): Promise<Row> {
  const id = `EV-${String(env.seq()).padStart(5, '0')}`;
  return env.repo.append('ATTENDANCE_EVENTS', {
    event_id: id, employee_id: emp, event_datetime: local, event_datetime_utc: local, event_type: type, capture_method: 'WEB', source: 'WEB',
    idempotency_key: id, company_id: IDS.company, created_at: local, created_by: 'test', request_id: id, status: 'ACTIVE', ...extra,
  });
}

export async function daily(env: Env, emp: string, date: string): Promise<Row> {
  const r = await env.repo.findOne('ATTENDANCE_DAILY', (x) => x.daily_key === `${emp}:${serialOf(date)}`);
  if (!r) throw new Error(`no daily row ${emp} ${date}`);
  return r;
}

export function serialOf(iso: string): number {
  return Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export async function scaffold(env: Env, from = '2026-09-01', to = '2026-09-30', emps?: string[]) {
  return scaffoldAttendanceDaily(env.repo, from, to, meta, emps);
}

export async function scaffoldPayroll(env: Env, period: string = IDS.period) {
  return scaffoldPayrollPeriod(env.repo, period, meta);
}

export async function addLeave(env: Env, emp: string, type: string, from: string, to: string, status = 'APPROVED', half = 'N') {
  const id = `LA-${String(env.seq()).padStart(4, '0')}`;
  return env.repo.append('LEAVE_APPLICATIONS', {
    application_id: id, employee_id: emp, leave_type_id: type, from_date: from, to_date: to, half_day: half, reason: 'test', idempotency_key: id,
    company_id: IDS.company, created_at: meta.now, created_by: 'test', request_id: id, status,
  });
}

export interface Punch { emp: string; type: 'IN' | 'OUT'; at: string }

/** one recalculation for many events */
export async function bulkPunches(env: Env, list: Punch[]): Promise<void> {
  await env.repo.appendMany('ATTENDANCE_EVENTS', list.map((p) => {
    const id = `EV-${String(env.seq()).padStart(5, '0')}`;
    return {
      event_id: id, employee_id: p.emp, event_datetime: p.at, event_datetime_utc: p.at, event_type: p.type, capture_method: 'WEB', source: 'WEB',
      idempotency_key: id, company_id: IDS.company, created_at: p.at, created_by: 'test', request_id: id, status: 'ACTIVE',
    };
  }));
}

/** full 09:00-18:00 days for the given ISO dates */
export function fullDays(emp: string, dates: string[], inT = '09:00:00', outT = '18:00:00'): Punch[] {
  return dates.flatMap((d) => [{ emp, type: 'IN' as const, at: `${d}T${inT}` }, { emp, type: 'OUT' as const, at: `${d}T${outT}` }]);
}

/** working weekdays between two ISO dates excluding listed dates */
export function weekdays(from: string, to: string, exclude: string[] = []): string[] {
  const out: string[] = [];
  for (let s = serialOf(from); s <= serialOf(to); s++) {
    const d = new Date(Date.UTC(1899, 11, 30) + s * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !exclude.includes(iso)) out.push(iso);
  }
  return out;
}

export async function calcRow(env: Env, emp: string, period: string = IDS.period): Promise<Row> {
  const r = await env.repo.findOne('PAYROLL_CALC', (x) => x.calc_key === `${period}:${emp}`);
  if (!r) throw new Error(`no payroll row ${emp}`);
  return r;
}
