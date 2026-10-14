import type { Row } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, notFound, str, toLocalWallClock } from '../common/core';
import { assertNotLocked } from '../common/period';
import { authorize, requireEmployeeAccess, scopedEmployeeIds } from '../auth/auth';

const nowLocal = (ctx: AppContext) => toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);

// ------------------------------------------------------------------ overtime

export async function requestOvertime(ctx: AppContext, actor: Actor, b: { workDate: string; dayType: 'REGULAR' | 'OFFDAY'; requestedMinutes: number; reason: string; employeeId?: string }) {
  const employeeId = b.employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'overtime', 'write', employeeId);
  const emp = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  if (!emp || emp.ot_eligible !== 'Y') throw new HttpError(422, 'NOT_OT_ELIGIBLE', 'Employee is not eligible for overtime');
  await assertNotLocked(ctx, b.workDate, 'This overtime');
  if (await ctx.repo.findOne('OVERTIME', (r) => r.employee_id === employeeId && r.work_date === b.workDate && r.day_type === b.dayType && (r.status === 'PENDING' || r.status === 'APPROVED'))) {
    throw conflict('An overtime request already exists for this date', 'DUPLICATE');
  }
  const row = await ctx.repo.append('OVERTIME', {
    ot_id: ctx.id('OT'), employee_id: employeeId, work_date: b.workDate, day_type: b.dayType, requested_minutes: b.requestedMinutes, reason: b.reason,
    approver_employee_id: str(emp.manager_employee_id) || undefined, ...auditCols(ctx, actor, 'PENDING'),
  });
  await ctx.audit.write(actor, { action: 'OVERTIME_REQUESTED', entityType: 'OVERTIME', entityId: str(row.ot_id), after: row });
  return row;
}

export async function decideOvertime(ctx: AppContext, actor: Actor, id: string, d: { decision: 'APPROVED' | 'REJECTED'; note?: string; approvedMinutes?: number }) {
  const ot = await ctx.repo.getByKey('OVERTIME', id);
  if (!ot) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'overtime', 'approve', str(ot.employee_id));
  if (str(ot.employee_id) === actor.user.employeeId) throw forbidden('You cannot approve your own overtime');
  if (ot.status !== 'PENDING') throw conflict(`Already ${str(ot.status)}`, 'ALREADY_DECIDED');
  await assertNotLocked(ctx, str(ot.work_date), 'This overtime');
  const approved = d.decision === 'APPROVED' ? Math.min(d.approvedMinutes ?? Number(ot.requested_minutes), Number(ot.requested_minutes)) : 0;
  const { before, after } = await ctx.repo.update('OVERTIME', id, { status: d.decision, approved_minutes: approved, decided_at: nowLocal(ctx), decided_by: actor.user.userId, decision_note: d.note, updated_at: nowLocal(ctx), updated_by: actor.user.userId });
  await ctx.audit.write(actor, { action: `OVERTIME_${d.decision}`, entityType: 'OVERTIME', entityId: id, before, after, reason: d.note });
  return after;
}

export async function listOvertime(ctx: AppContext, actor: Actor) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'overtime', 'read');
  return ctx.repo.find('OVERTIME', (r) => ids === 'ALL' || ids.has(str(r.employee_id)));
}

// ------------------------------------------------------------------ timesheets

export async function submitTimesheet(ctx: AppContext, actor: Actor, b: { workDate: string; projectCode: string; task: string; hours: number; billable: 'Y' | 'N'; employeeId?: string }) {
  const employeeId = b.employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'timesheets', 'write', employeeId);
  if (!(await ctx.systemConfig()).yn('FEATURE_TIMESHEETS')) throw new HttpError(403, 'FEATURE_DISABLED', 'Timesheets are disabled');
  await assertNotLocked(ctx, b.workDate, 'This timesheet');
  const emp = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  const row = await ctx.repo.append('TIMESHEETS', {
    timesheet_id: ctx.id('TS'), employee_id: employeeId, work_date: b.workDate, project_code: b.projectCode, task: b.task, hours: b.hours, billable: b.billable,
    approver_employee_id: str(emp?.manager_employee_id) || undefined, ...auditCols(ctx, actor, 'PENDING'),
  });
  await ctx.audit.write(actor, { action: 'TIMESHEET_SUBMITTED', entityType: 'TIMESHEET', entityId: str(row.timesheet_id), after: row });
  return row;
}

export async function decideTimesheet(ctx: AppContext, actor: Actor, id: string, d: { decision: 'APPROVED' | 'REJECTED'; note?: string }) {
  const t = await ctx.repo.getByKey('TIMESHEETS', id);
  if (!t) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'timesheets', 'approve', str(t.employee_id));
  if (str(t.employee_id) === actor.user.employeeId) throw forbidden('You cannot approve your own timesheet');
  if (t.status !== 'PENDING') throw conflict(`Already ${str(t.status)}`, 'ALREADY_DECIDED');
  const { before, after } = await ctx.repo.update('TIMESHEETS', id, { status: d.decision, decided_at: nowLocal(ctx), decided_by: actor.user.userId });
  await ctx.audit.write(actor, { action: `TIMESHEET_${d.decision}`, entityType: 'TIMESHEET', entityId: id, before, after, reason: d.note });
  return after;
}

export async function listTimesheets(ctx: AppContext, actor: Actor) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'timesheets', 'read');
  return ctx.repo.find('TIMESHEETS', (r) => ids === 'ALL' || ids.has(str(r.employee_id)));
}

// ------------------------------------------------------------------ expenses -> reimbursements

export async function submitExpense(ctx: AppContext, actor: Actor, b: { expenseDate: string; category: string; description: string; amount: number; employeeId?: string }) {
  const employeeId = b.employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'expenses', 'write', employeeId);
  const emp = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  const row = await ctx.repo.append('EXPENSES', {
    expense_id: ctx.id('EXP'), employee_id: employeeId, expense_date: b.expenseDate, category: b.category, description: b.description, amount: b.amount, currency: 'INR',
    approver_employee_id: str(emp?.manager_employee_id) || undefined, ...auditCols(ctx, actor, 'PENDING'),
  });
  await ctx.audit.write(actor, { action: 'EXPENSE_SUBMITTED', entityType: 'EXPENSE', entityId: str(row.expense_id), after: row });
  return row;
}

export async function decideExpense(ctx: AppContext, actor: Actor, id: string, d: { decision: 'APPROVED' | 'REJECTED'; note?: string }) {
  const e = await ctx.repo.getByKey('EXPENSES', id);
  if (!e) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'expenses', 'approve', str(e.employee_id));
  if (str(e.employee_id) === actor.user.employeeId) throw forbidden('You cannot approve your own expense');
  if (e.status !== 'PENDING') throw conflict(`Already ${str(e.status)}`, 'ALREADY_DECIDED');
  if (d.decision === 'APPROVED') {
    const open = (await ctx.repo.readAll('PAYROLL_CONTROL')).filter((p) => p.run_type === 'REGULAR' && ['OPEN', 'PROCESSING', 'REVIEW'].includes(str(p.status))).sort((a, b) => str(a.period_start).localeCompare(str(b.period_start)))[0];
    if (!open) throw new HttpError(422, 'NO_OPEN_PERIOD', 'No open payroll period to attach the reimbursement to');
    await ctx.repo.appendIfAbsent('REIMBURSEMENTS', 'reimbursement_id', {
      reimbursement_id: `RB-${id}`, expense_id: id, employee_id: e.employee_id, period_id: open.period_id, amount: e.amount, description: str(e.description), ...auditCols(ctx, actor, 'APPROVED'),
    });
  }
  const { before, after } = await ctx.repo.update('EXPENSES', id, { status: d.decision, decided_at: nowLocal(ctx), decided_by: actor.user.userId, decision_note: d.note });
  await ctx.audit.write(actor, { action: `EXPENSE_${d.decision}`, entityType: 'EXPENSE', entityId: id, before, after, reason: d.note });
  return after;
}

export async function listExpenses(ctx: AppContext, actor: Actor) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'expenses', 'read');
  return ctx.repo.find('EXPENSES', (r) => ids === 'ALL' || ids.has(str(r.employee_id)));
}

// ------------------------------------------------------------------ loans / advances

function nextPeriodIds(start: string, n: number): string[] {
  const m = /^PR-(\d{4})-(\d{2})$/.exec(start);
  if (!m) throw badRequest('startPeriodId must look like PR-YYYY-MM');
  let y = +m[1];
  let mo = +m[2];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`PR-${y}-${String(mo).padStart(2, '0')}`);
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return out;
}

export async function createLoan(ctx: AppContext, actor: Actor, b: { employeeId: string; loanType: 'LOAN' | 'ADVANCE'; principal: number; annualInterestRate: number; tenureMonths: number; startPeriodId: string; purpose: string }) {
  await requireEmployeeAccess(ctx, actor, 'loans', 'approve', b.employeeId);
  if (b.loanType === 'ADVANCE' && b.annualInterestRate !== 0) throw badRequest('Advances are interest free');
  const loanId = ctx.id('LN');
  const loan = await ctx.repo.append('LOANS', {
    loan_id: loanId, employee_id: b.employeeId, loan_type: b.loanType, principal: b.principal, annual_interest_rate: b.annualInterestRate, tenure_months: b.tenureMonths,
    start_period_id: b.startPeriodId, disbursed_on: nowLocal(ctx).slice(0, 10), purpose: b.purpose, approver_employee_id: actor.user.employeeId, approved_at: nowLocal(ctx), ...auditCols(ctx, actor, 'ACTIVE'),
  });
  await ctx.repo.appendMany('LOAN_SCHEDULE', nextPeriodIds(b.startPeriodId, b.tenureMonths).map((pid, i) => ({
    schedule_id: `${loanId}-${String(i + 1).padStart(3, '0')}`, loan_id: loanId, employee_id: b.employeeId, loan_type: b.loanType, installment_no: i + 1, due_period_id: pid, ...auditCols(ctx, actor, 'SCHEDULED'),
  })));
  await ctx.audit.write(actor, { action: 'LOAN_CREATED', entityType: 'LOAN', entityId: loanId, after: loan });
  return ctx.repo.getByKey('LOANS', loanId) as Promise<Row>;
}

export async function listLoans(ctx: AppContext, actor: Actor) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'loans', 'read');
  return ctx.repo.find('LOANS', (r) => ids === 'ALL' || ids.has(str(r.employee_id)));
}

export async function declareTax(ctx: AppContext, actor: Actor, b: { financialYear: string; regime: 'NEW' | 'OLD'; section: string; description: string; declaredAmount: number }) {
  await authorize(ctx, actor.user, 'tax', 'write');
  const row = await ctx.repo.append('TAX_DECLARATIONS', {
    declaration_id: ctx.id('TAX'), employee_id: actor.user.employeeId, financial_year: b.financialYear, regime: b.regime, section: b.section, description: b.description, declared_amount: b.declaredAmount, ...auditCols(ctx, actor, 'PENDING'),
  });
  await ctx.audit.write(actor, { action: 'TAX_DECLARED', entityType: 'TAX_DECLARATION', entityId: str(row.declaration_id), after: row });
  return row;
}

export async function listTax(ctx: AppContext, actor: Actor) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'tax', 'read');
  return ctx.repo.find('TAX_DECLARATIONS', (r) => ids === 'ALL' || ids.has(str(r.employee_id)));
}

export async function verifyTax(ctx: AppContext, actor: Actor, id: string, verifiedAmount: number) {
  const t = await ctx.repo.getByKey('TAX_DECLARATIONS', id);
  if (!t) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'tax', 'write', str(t.employee_id));
  if (str(t.employee_id) === actor.user.employeeId) throw forbidden('You cannot verify your own declaration');
  const { before, after } = await ctx.repo.update('TAX_DECLARATIONS', id, { status: 'APPROVED', verified_amount: verifiedAmount, verified_by: actor.user.userId });
  await ctx.audit.write(actor, { action: 'TAX_VERIFIED', entityType: 'TAX_DECLARATION', entityId: id, before, after });
  return after;
}

// ------------------------------------------------------------------ approvals inbox

export async function approvalsInbox(ctx: AppContext, actor: Actor) {
  const out: Array<{ type: string; id: string; employeeId: string; summary: string; date: string }> = [];
  const add = async (type: string, resource: 'leave' | 'adjustments' | 'overtime' | 'timesheets' | 'expenses', tab: string, idCol: string, summary: (r: Row) => string, date: (r: Row) => string) => {
    let ids: Set<string> | 'ALL';
    try { ids = await scopedEmployeeIds(ctx, actor.user, resource, 'approve'); } catch { return; }
    for (const r of await ctx.repo.find(tab, (x) => x.status === 'PENDING')) {
      const emp = str(r.employee_id);
      if (emp === actor.user.employeeId) continue;
      if (ids === 'ALL' || ids.has(emp)) out.push({ type, id: str(r[idCol]), employeeId: emp, summary: summary(r), date: date(r) });
    }
  };
  await add('LEAVE', 'leave', 'LEAVE_APPLICATIONS', 'application_id', (r) => `${str(r.leave_type_id)} ${str(r.from_date)} -> ${str(r.to_date)} (${str(r.days_count)}d)`, (r) => str(r.created_at));
  await add('REGULARISATION', 'adjustments', 'ATTENDANCE_ADJUSTMENTS', 'adjustment_id', (r) => `${str(r.work_date)} ${str(r.adjustment_type)}: ${str(r.reason)}`, (r) => str(r.created_at));
  await add('OVERTIME', 'overtime', 'OVERTIME', 'ot_id', (r) => `${str(r.work_date)} ${str(r.requested_minutes)} min ${str(r.day_type)}`, (r) => str(r.created_at));
  await add('TIMESHEET', 'timesheets', 'TIMESHEETS', 'timesheet_id', (r) => `${str(r.work_date)} ${str(r.project_code)} ${str(r.hours)}h`, (r) => str(r.created_at));
  await add('EXPENSE', 'expenses', 'EXPENSES', 'expense_id', (r) => `${str(r.category)} ${str(r.amount)}`, (r) => str(r.created_at));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
