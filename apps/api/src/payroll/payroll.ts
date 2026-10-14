import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PAYROLL_TRANSITIONS, type PayrollStatus } from '@nutex/types';
import type { Row } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, notFound, str, toLocalWallClock } from '../common/core';
import { authorize, requireEmployeeAccess, scopedEmployeeIds } from '../auth/auth';
import { scaffoldAttendanceDaily, scaffoldPayrollPeriod } from '../common/scaffold';
import { driveFolder } from '../drive/folders';

const nowLocal = (ctx: AppContext) => toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
const metaOf = (ctx: AppContext, actor: Actor) => ({ companyId: actor.user.companyId, actor: actor.user.userId, requestId: actor.requestId, now: nowLocal(ctx) });

export async function listPeriods(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'payroll', 'read');
  return (await ctx.repo.readAll('PAYROLL_CONTROL')).sort((a, b) => str(b.period_start).localeCompare(str(a.period_start)));
}

export async function getPeriod(ctx: AppContext, actor: Actor, periodId: string): Promise<Row> {
  await authorize(ctx, actor.user, 'payroll', 'read');
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound('Payroll period not found');
  return p;
}

export async function createPeriod(ctx: AppContext, actor: Actor, b: { periodId: string; label: string; start: string; end: string; runType: 'REGULAR' | 'OFF_CYCLE'; cutoff?: string }) {
  await authorize(ctx, actor.user, 'payroll', 'write');
  if (b.start > b.end) throw badRequest('start must be on or before end');
  const all = await ctx.repo.readAll('PAYROLL_CONTROL');
  if (all.some((p) => p.period_id === b.periodId)) throw conflict('Period id already exists');
  if (b.runType === 'REGULAR' && all.some((p) => p.run_type === 'REGULAR' && str(p.period_start) <= b.end && str(p.period_end) >= b.start)) throw conflict('A regular period already covers these dates', 'PERIOD_OVERLAP');
  const row = await ctx.repo.append('PAYROLL_CONTROL', {
    period_id: b.periodId, period_label: b.label, period_start: b.start, period_end: b.end, cutoff_date: b.cutoff, run_type: b.runType, version: 1, ...auditCols(ctx, actor, 'OPEN'),
  });
  await ctx.audit.write(actor, { action: 'PAYROLL_PERIOD_CREATED', entityType: 'PAYROLL_PERIOD', entityId: b.periodId, after: row });
  return row;
}

/** creates the input rows the payroll formulas fill in (attendance rows for the whole period + payroll rows per employee) */
export async function openInputs(ctx: AppContext, actor: Actor, periodId: string) {
  await authorize(ctx, actor.user, 'payroll', 'write');
  const p = await getPeriod(ctx, actor, periodId);
  if (p.status === 'APPROVED' || p.status === 'LOCKED') throw conflict(`Period is ${str(p.status)}`, 'PERIOD_NOT_EDITABLE');
  let daily = 0;
  if (p.run_type === 'REGULAR') daily = await scaffoldAttendanceDaily(ctx.repo, str(p.period_start), str(p.period_end), metaOf(ctx, actor));
  const r = await scaffoldPayrollPeriod(ctx.repo, periodId, metaOf(ctx, actor));
  await ctx.audit.write(actor, { action: 'PAYROLL_INPUTS_OPENED', entityType: 'PAYROLL_PERIOD', entityId: periodId, after: { attendanceRows: daily, ...r } });
  return { attendanceRows: daily, ...r };
}

export async function updateInput(ctx: AppContext, actor: Actor, periodId: string, employeeId: string, patch: Record<string, unknown>) {
  await requireEmployeeAccess(ctx, actor, 'payroll', 'write', employeeId);
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound('Payroll period not found');
  if (!['OPEN', 'PROCESSING', 'REVIEW'].includes(str(p.status))) throw new HttpError(423, 'PERIOD_NOT_EDITABLE', `Inputs cannot change while the period is ${str(p.status)}`);
  if (patch.manual_adjustment !== undefined && Number(patch.manual_adjustment) !== 0 && !str(patch.manual_adjustment_reason).trim()) throw badRequest('manual_adjustment requires manual_adjustment_reason');
  if (patch.tds_manual_flag === 'Y' && patch.tds_manual_amount === undefined) throw badRequest('tds_manual_amount is required when tds_manual_flag is Y');
  const key = `PI-${periodId}-${employeeId}`;
  const { before, after } = await ctx.repo.update('PAYROLL_INPUTS', key, { ...patch, updated_at: nowLocal(ctx), updated_by: actor.user.userId, request_id: actor.requestId });
  await ctx.audit.write(actor, { action: 'PAYROLL_INPUT_UPDATED', entityType: 'PAYROLL_INPUT', entityId: key, before, after, reason: str(patch.manual_adjustment_reason) || undefined });
  return after;
}

const calcFields = ['calc_key', 'period_id', 'employee_id', 'run_type', 'paid_days', 'lop_days', 'earned_fixed_total', 'ot_amount', 'bonus', 'incentive', 'arrears', 'manual_adjustment', 'gross_earnings', 'pf_emp', 'pf_er', 'esi_emp', 'esi_er', 'pt', 'lwf_emp', 'tds', 'loan_emi', 'advance_recovery', 'other_deduction', 'reimbursement', 'total_deductions', 'net_pay', 'employer_cost', 'check_status'];

/** locked periods are read from the immutable snapshot, everything else from the live formulas */
export async function calcRows(ctx: AppContext, actor: Actor, periodId: string): Promise<{ source: 'SNAPSHOT' | 'LIVE'; rows: Array<Record<string, unknown>> }> {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'payroll', 'read');
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound('Payroll period not found');
  const allow = (r: Row) => ids === 'ALL' || ids.has(str(r.employee_id));
  if (p.status === 'LOCKED') {
    const latest = new Map<string, Row>();
    for (const r of await ctx.repo.find('PAYROLL_SNAPSHOT', (x) => x.period_id === periodId && allow(x))) {
      const k = str(r.employee_id);
      if (!latest.has(k) || Number(r.period_version) > Number(latest.get(k)!.period_version)) latest.set(k, r);
    }
    return { source: 'SNAPSHOT', rows: [...latest.values()].map(({ calc_json, inputs_json, rules_json, ...rest }) => { void calc_json; void inputs_json; void rules_json; return rest; }) };
  }
  const rows = (await ctx.repo.find('PAYROLL_CALC', (r) => r.period_id === periodId && allow(r))).map((r) => Object.fromEntries(calcFields.map((f) => [f, r[f] ?? null])));
  return { source: 'LIVE', rows };
}

export async function myPayslips(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'payslips', 'read');
  const ids = await scopedEmployeeIds(ctx, actor.user, 'payslips', 'read');
  return ctx.repo.find('PAYSLIPS', (r) => (ids === 'ALL' || ids.has(str(r.employee_id))) && r.status === 'ACTIVE');
}

// ------------------------------------------------------------------ lifecycle

function sha(v: unknown): string { return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }

export async function transition(ctx: AppContext, actor: Actor, periodId: string, to: PayrollStatus, note?: string) {
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound('Payroll period not found');
  const from = str(p.status) as PayrollStatus;
  if (!(PAYROLL_TRANSITIONS[from] ?? []).includes(to)) throw new HttpError(409, 'INVALID_TRANSITION', `${from} -> ${to} is not allowed`);
  const need = to === 'APPROVED' || to === 'LOCKED' ? 'approve' : 'write';
  await authorize(ctx, actor.user, 'payroll', need);
  const patch: Record<string, unknown> = { status: to, updated_at: nowLocal(ctx), updated_by: actor.user.userId, request_id: actor.requestId };

  if (to === 'PROCESSING') await openInputs(ctx, actor, periodId);
  if (to === 'REVIEW') patch.submitted_by = actor.user.userId;
  if (to === 'APPROVED') {
    if (p.ready_to_approve !== 'YES') throw new HttpError(422, 'NOT_READY', `Period has ${str(p.issue_count)} row(s) needing attention (see check_status)`);
    if (str(p.submitted_by) && str(p.submitted_by) === actor.user.userId) throw forbidden('Maker-checker: the approver must differ from the person who submitted the period for review');
    patch.approved_by = actor.user.userId;
    patch.approved_at = nowLocal(ctx);
  }
  if (to === 'LOCKED') {
    if (p.ready_to_approve !== 'YES') throw new HttpError(422, 'NOT_READY', 'Period is no longer ready; return it to REVIEW and fix the issues');
    const { hash } = await writeSnapshot(ctx, actor, p);
    patch.snapshot_hash = hash;
    patch.locked_by = actor.user.userId;
    patch.locked_at = nowLocal(ctx);
  }
  const { before, after } = await ctx.repo.update('PAYROLL_CONTROL', periodId, patch);
  await ctx.audit.write(actor, { action: `PAYROLL_${to}`, entityType: 'PAYROLL_PERIOD', entityId: periodId, before: { status: from }, after: { status: to, snapshot_hash: patch.snapshot_hash }, reason: note });
  void before;
  return after;
}

/** copy PAYROLL_CALC to PAYROLL_SNAPSHOT as VALUES (idempotent per snapshot_id), then mark scheduled loan installments deducted */
async function writeSnapshot(ctx: AppContext, actor: Actor, p: Row): Promise<{ hash: string; rows: number }> {
  const periodId = str(p.period_id);
  const version = Number(p.version ?? 1);
  const calc = await ctx.repo.find('PAYROLL_CALC', (r) => r.period_id === periodId);
  const inputs = new Map((await ctx.repo.find('PAYROLL_INPUTS', (r) => r.period_id === periodId)).map((r) => [str(r.employee_id), r]));
  const rules = (await ctx.repo.readAll('STATUTORY_RULES')).filter((r) => r.status === 'ACTIVE' && str(r.effective_from) <= str(p.period_end) && (!str(r.effective_to) || str(r.effective_to) >= str(p.period_end)))
    .map((r) => ({ code: r.rule_code, value: r.value, from: r.effective_from, to: r.effective_to, version: r.version, jurisdiction: r.jurisdiction }));
  const existing = new Set((await ctx.repo.find('PAYROLL_SNAPSHOT', (r) => r.period_id === periodId)).map((r) => str(r.snapshot_id)));
  const stamp = nowLocal(ctx);
  const items: Record<string, unknown>[] = [];
  const hashes: string[] = [];
  for (const c of calc.sort((a, b) => str(a.employee_id).localeCompare(str(b.employee_id)))) {
    const clean = Object.fromEntries(Object.entries(c).filter(([k]) => k !== '_row'));
    const rowHash = sha(clean);
    hashes.push(rowHash);
    const id = `SNAP-${periodId}-v${version}-${str(c.employee_id)}`;
    if (existing.has(id)) continue;
    const inp = inputs.get(str(c.employee_id));
    items.push({
      snapshot_id: id, period_id: periodId, period_version: version, employee_id: c.employee_id, paid_days: c.paid_days, lop_days: c.lop_days, gross_earnings: c.gross_earnings,
      pf_emp: c.pf_emp, esi_emp: c.esi_emp, pt: c.pt, lwf_emp: c.lwf_emp, tds: c.tds, loan_emi: c.loan_emi, advance_recovery: c.advance_recovery, other_deduction: c.other_deduction,
      reimbursement: c.reimbursement, total_deductions: c.total_deductions, net_pay: c.net_pay, employer_cost: c.employer_cost, calc_json: clean,
      inputs_json: inp ? Object.fromEntries(Object.entries(inp).filter(([k]) => k !== '_row')) : {}, rules_json: rules, row_hash: rowHash, locked_at: stamp, locked_by: actor.user.userId, request_id: actor.requestId,
    });
  }
  if (items.length) await ctx.repo.appendMany('PAYROLL_SNAPSHOT', items);

  if (p.run_type === 'REGULAR') {
    for (const s of await ctx.repo.find('LOAN_SCHEDULE', (r) => r.due_period_id === periodId && r.status === 'SCHEDULED')) {
      await ctx.repo.update('LOAN_SCHEDULE', str(s.schedule_id), { status: 'DEDUCTED', deducted_in_period_id: periodId, deducted_at: stamp });
    }
  }
  return { hash: sha(hashes), rows: calc.length };
}

/** prove a locked period still matches its snapshot (detects tampering with the snapshot tab) */
export async function verifySnapshot(ctx: AppContext, actor: Actor, periodId: string) {
  await authorize(ctx, actor.user, 'payroll', 'read');
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p || p.status !== 'LOCKED') throw conflict('Period is not locked');
  const rows = (await ctx.repo.find('PAYROLL_SNAPSHOT', (r) => r.period_id === periodId && Number(r.period_version) === Number(p.version))).sort((a, b) => str(a.employee_id).localeCompare(str(b.employee_id)));
  const hashes = rows.map((r) => {
    let calc: unknown = {};
    try { calc = JSON.parse(str(r.calc_json)); } catch { /* corrupted: hash will not match */ }
    return { stored: str(r.row_hash), actual: sha(calc) };
  });
  const rowsOk = hashes.every((h) => h.stored === h.actual);
  return { rows: rows.length, rowsOk, periodHashOk: sha(hashes.map((h) => h.stored)) === str(p.snapshot_hash) };
}

// ------------------------------------------------------------------ payslips + exports

export async function generatePayslips(ctx: AppContext, actor: Actor, periodId: string) {
  await authorize(ctx, actor.user, 'payslips', 'write');
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound('Payroll period not found');
  if (p.status !== 'LOCKED') throw new HttpError(409, 'PERIOD_NOT_LOCKED', 'Payslips are generated from the locked snapshot');
  const folder = await driveFolder(ctx, 'PAYSLIP');
  const snaps = await ctx.repo.find('PAYROLL_SNAPSHOT', (r) => r.period_id === periodId && Number(r.period_version) === Number(p.version));
  const existing = new Set((await ctx.repo.find('PAYSLIPS', (r) => r.period_id === periodId)).map((r) => str(r.payslip_id)));
  const employees = new Map((await ctx.repo.readAll('EMPLOYEES')).map((e) => [str(e.employee_id), e]));
  let created = 0;
  for (const s of snaps) {
    const id = `PS-${periodId}-${str(s.employee_id)}`;
    if (existing.has(id)) continue;
    const pdf = await renderPayslip(str(p.period_label), employees.get(str(s.employee_id)), s);
    const buf = Buffer.from(pdf);
    const file = await ctx.drive.put(folder, `${id}.pdf`, buf, 'application/pdf');
    await ctx.repo.append('PAYSLIPS', {
      payslip_id: id, period_id: periodId, employee_id: s.employee_id, snapshot_id: s.snapshot_id, drive_file_id: file.id, file_name: `${id}.pdf`, checksum: createHash('sha256').update(buf).digest('hex'),
      generated_at: nowLocal(ctx), generated_by: actor.user.userId, published_at: nowLocal(ctx), ...auditCols(ctx, actor),
    });
    created++;
  }
  await ctx.audit.write(actor, { action: 'PAYSLIPS_GENERATED', entityType: 'PAYROLL_PERIOD', entityId: periodId, after: { created } });
  return { created, total: snaps.length };
}

export async function getPayslipPdf(ctx: AppContext, actor: Actor, payslipId: string): Promise<{ data: Buffer; name: string }> {
  const r = await ctx.repo.getByKey('PAYSLIPS', payslipId);
  if (!r) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'payslips', 'read', str(r.employee_id));
  const data = await ctx.drive.get(str(r.drive_file_id));
  if (createHash('sha256').update(data).digest('hex') !== str(r.checksum)) throw new HttpError(500, 'PAYSLIP_INTEGRITY', 'Payslip file failed its integrity check');
  await ctx.audit.write(actor, { action: 'PAYSLIP_DOWNLOADED', entityType: 'PAYSLIP', entityId: payslipId });
  return { data, name: str(r.file_name) };
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function renderPayslip(periodLabel: string, emp: Row | undefined, snap: Row): Promise<Uint8Array> {
  const calc = JSON.parse(str(snap.calc_json) || '{}') as Record<string, unknown>;
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const text = (t: string, x: number, size = 10, f = font, color = rgb(0.08, 0.12, 0.1)) => page.drawText(t.replace(/[^\x20-\x7E]/g, '?'), { x, y, size, font: f, color });
  page.drawRectangle({ x: 0, y: 790, width: 595, height: 52, color: rgb(0.04, 0.16, 0.13) });
  y = 810;
  text('NUTEX', 40, 20, bold, rgb(0.42, 0.95, 0.6));
  text('Smart Attendance  |  Payslip', 140, 10, font, rgb(0.85, 0.95, 0.9));
  y = 760;
  text(`Pay period: ${periodLabel}`, 40, 11, bold);
  y -= 18; text(`Employee: ${str(emp?.first_name)} ${str(emp?.last_name)}  (${str(emp?.employee_code)})`, 40);
  y -= 14; text(`Paid days: ${str(snap.paid_days)}    LOP days: ${str(snap.lop_days)}`, 40);
  y -= 30; text('EARNINGS', 40, 11, bold); text('DEDUCTIONS', 310, 11, bold);
  const earn: Array<[string, unknown]> = [['Basic', calc.earned_basic], ['HRA', calc.earned_hra], ['DA', calc.earned_da], ['Conveyance', calc.earned_conveyance], ['Special allowance', calc.earned_special], ['Other allowance', calc.earned_other], ['Overtime', calc.ot_amount], ['Bonus', calc.bonus], ['Incentive', calc.incentive], ['Arrears', calc.arrears], ['Adjustments', calc.manual_adjustment]];
  const ded: Array<[string, unknown]> = [['Provident fund', snap.pf_emp], ['ESI', snap.esi_emp], ['Professional tax', snap.pt], ['LWF', snap.lwf_emp], ['Income tax (TDS)', snap.tds], ['Loan EMI', snap.loan_emi], ['Advance recovery', snap.advance_recovery], ['Other deductions', snap.other_deduction]];
  const start = y - 18;
  y = start;
  for (const [l, v] of earn.filter(([, v]) => Number(v ?? 0) !== 0)) { text(l, 40); text(money(v), 200); y -= 14; }
  const endE = y;
  y = start;
  for (const [l, v] of ded.filter(([, v]) => Number(v ?? 0) !== 0)) { text(l, 310); text(money(v), 470); y -= 14; }
  y = Math.min(endE, y) - 12;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.6, color: rgb(0.6, 0.7, 0.65) });
  y -= 16; text('Gross earnings', 40, 10, bold); text(money(snap.gross_earnings), 200, 10, bold); text('Total deductions', 310, 10, bold); text(money(snap.total_deductions), 470, 10, bold);
  y -= 14; text('Reimbursements', 40); text(money(snap.reimbursement), 200);
  y -= 28; text('NET PAY', 40, 14, bold); text(`INR ${money(snap.net_pay)}`, 200, 14, bold);
  y -= 40; text('System generated from the locked payroll snapshot. Values are calculated in the NUTEX Google Sheets workbook.', 40, 8, font, rgb(0.4, 0.45, 0.42));
  return doc.save();
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(ctx: AppContext, actor: Actor, periodId: string, kind: 'bank' | 'pf' | 'esi' | 'register') {
  await authorize(ctx, actor.user, 'payroll', 'export');
  const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
  if (!p) throw notFound();
  if (!['APPROVED', 'LOCKED'].includes(str(p.status))) throw new HttpError(409, 'PERIOD_NOT_APPROVED', 'Exports are available once the period is APPROVED');
  const { rows } = await calcRows(ctx, actor, periodId);
  const employees = new Map((await ctx.repo.readAll('EMPLOYEES')).map((e) => [str(e.employee_id), e]));
  const head: Record<string, string[]> = {
    bank: ['employee_code', 'name', 'bank_account_ref', 'ifsc', 'net_pay'], pf: ['employee_code', 'name', 'pf_employee', 'gross'], esi: ['employee_code', 'name', 'esi_employee', 'gross'],
    register: ['employee_code', 'name', 'paid_days', 'lop_days', 'gross', 'total_deductions', 'net_pay', 'employer_cost'],
  };
  const line = (r: Record<string, unknown>): unknown[] => {
    const e = employees.get(str(r.employee_id));
    const name = `${str(e?.first_name)} ${str(e?.last_name)}`.trim();
    const code = str(e?.employee_code);
    if (kind === 'bank') return [code, name, str(e?.bank_account_ref), str(e?.bank_ifsc), r.net_pay];
    if (kind === 'pf') return [code, name, r.pf_emp, r.gross_earnings];
    if (kind === 'esi') return [code, name, r.esi_emp, r.gross_earnings];
    return [code, name, r.paid_days, r.lop_days, r.gross_earnings, r.total_deductions, r.net_pay, r.employer_cost];
  };
  const body = [head[kind].join(','), ...rows.map((r) => line(r).map(csvCell).join(','))].join('\n');
  await ctx.audit.write(actor, { action: 'PAYROLL_EXPORT', entityType: 'PAYROLL_PERIOD', entityId: periodId, after: { kind, rows: rows.length } });
  return body;
}

export async function createFullFinal(ctx: AppContext, actor: Actor, b: { employeeId: string; lastWorkingDay: string; noticePeriodDays?: number; noticeServedDays?: number; exitPeriodId?: string; pendingSalaryIncluded: 'Y' | 'N'; otherDues?: number; otherPayables?: number }) {
  await requireEmployeeAccess(ctx, actor, 'payroll', 'write', b.employeeId);
  const row = await ctx.repo.append('FULL_FINAL', {
    ff_id: ctx.id('FF'), employee_id: b.employeeId, last_working_day: b.lastWorkingDay, notice_period_days: b.noticePeriodDays, notice_served_days: b.noticeServedDays, exit_period_id: b.exitPeriodId,
    pending_salary_included: b.pendingSalaryIncluded, other_dues_recoverable: b.otherDues, other_payables: b.otherPayables, ...auditCols(ctx, actor, 'DRAFT'),
  });
  await ctx.audit.write(actor, { action: 'FULL_FINAL_CREATED', entityType: 'FULL_FINAL', entityId: str(row.ff_id), after: row });
  return row;
}

export async function decideFullFinal(ctx: AppContext, actor: Actor, id: string, to: 'REVIEW' | 'APPROVED' | 'PAID') {
  const ff = await ctx.repo.getByKey('FULL_FINAL', id);
  if (!ff) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'payroll', to === 'REVIEW' ? 'write' : 'approve', str(ff.employee_id));
  const order = ['DRAFT', 'REVIEW', 'APPROVED', 'PAID'];
  if (order.indexOf(to) !== order.indexOf(str(ff.status)) + 1) throw new HttpError(409, 'INVALID_TRANSITION', `${str(ff.status)} -> ${to}`);
  if (to === 'APPROVED' && str(ff.updated_by) === actor.user.userId && str(ff.status) === 'REVIEW') throw forbidden('Maker-checker: approver must differ from the reviewer');
  const { before, after } = await ctx.repo.update('FULL_FINAL', id, { status: to, decided_at: nowLocal(ctx), updated_at: nowLocal(ctx), updated_by: actor.user.userId });
  await ctx.audit.write(actor, { action: `FULL_FINAL_${to}`, entityType: 'FULL_FINAL', entityId: id, before, after });
  return after;
}
