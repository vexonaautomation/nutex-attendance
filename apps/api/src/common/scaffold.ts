import { SheetRepository, dateToSerial, serialToDate, type Row } from '@nutex/sheet-connector';

/**
 * Scaffolding jobs create the *input* rows (employee x date, employee x period) that the sheet formulas then fill in.
 * They contain no business calculation: they only decide which keys must exist.
 */

function* dates(from: string, to: string): Generator<string> {
  for (let s = dateToSerial(from); s <= dateToSerial(to); s++) yield serialToDate(s);
}

export interface ScaffoldMeta { companyId: string; actor: string; requestId: string; now: string }

export async function scaffoldAttendanceDaily(repo: SheetRepository, from: string, to: string, meta: ScaffoldMeta, employeeIds?: string[]): Promise<number> {
  const employees = await repo.readAll('EMPLOYEES');
  const existing = new Set((await repo.readAll('ATTENDANCE_DAILY')).map((r) => String(r.attendance_id)));
  const items: Record<string, unknown>[] = [];
  for (const e of employees) {
    const id = String(e.employee_id);
    if (employeeIds && !employeeIds.includes(id)) continue;
    const join = e.date_of_joining as string | null;
    const exit = e.date_of_exit as string | null;
    for (const d of dates(from, to)) {
      if (join && d < join) continue;
      if (exit && d > exit) continue;
      const attendance_id = `AD-${id}-${d}`;
      if (existing.has(attendance_id)) continue;
      items.push({ attendance_id, employee_id: id, work_date: d, company_id: meta.companyId, created_at: meta.now, created_by: meta.actor, request_id: meta.requestId, status_flag: 'ACTIVE' });
    }
  }
  if (items.length) await repo.appendMany('ATTENDANCE_DAILY', items);
  return items.length;
}

export interface PayrollScaffoldResult { created: number; skipped: number }

/** one PAYROLL_INPUTS + PAYROLL_CALC + STATUTORY_CALC row per employee active in the period */
export async function scaffoldPayrollPeriod(repo: SheetRepository, periodId: string, meta: ScaffoldMeta): Promise<PayrollScaffoldResult> {
  const period = await repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!period) throw new Error(`Payroll period ${periodId} not found`);
  if (period.status === 'LOCKED') throw new Error(`Payroll period ${periodId} is LOCKED`);
  const ps = period.period_start as string;
  const pe = period.period_end as string;
  const employees = await repo.readAll('EMPLOYEES');
  const existing = new Set((await repo.readAll('PAYROLL_INPUTS')).filter((r) => r.period_id === periodId).map((r) => String(r.employee_id)));
  const active = employees.filter((e: Row) => {
    const join = e.date_of_joining as string | null;
    const exit = e.date_of_exit as string | null;
    return (!join || join <= pe) && (!exit || exit >= ps);
  });
  const todo = active.filter((e) => !existing.has(String(e.employee_id)));
  const base = { company_id: meta.companyId, created_at: meta.now, created_by: meta.actor, request_id: meta.requestId };
  if (todo.length) {
    const inputs = todo.map((e) => ({ input_id: `PI-${periodId}-${e.employee_id}`, period_id: periodId, employee_id: e.employee_id, ...base, updated_at: meta.now, updated_by: meta.actor, source: 'API', status: 'ACTIVE' }));
    await repo.appendMany('PAYROLL_INPUTS', inputs);
    await repo.appendMany('PAYROLL_CALC', inputs.map((i) => ({ input_id: i.input_id, ...base })));
    await repo.appendMany('STATUTORY_CALC', inputs.map((i) => ({ input_id: i.input_id, ...base })));
  }
  return { created: todo.length, skipped: active.length - todo.length };
}
