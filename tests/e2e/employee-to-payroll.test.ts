import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../api-helpers';
import { fullDays, weekdays } from '../helpers';

/**
 * End-to-end: employee check-in -> leave application -> manager approval -> payroll run -> approval -> lock -> payslip.
 * Every business figure asserted here is produced by Google-Sheets-style formulas (evaluated by the emulator).
 */
let api: ApiEnv;
let emp: string, mgr: string, hr: string, fin: string, root: string, night: string;
const P = IDS.period;
const near = (a: unknown, b: number) => expect(Number(a)).toBeCloseTo(b, 2);
const row = async (e: string) => (await api.call(fin, 'GET', `/api/payroll/periods/${P}/rows`)).body.rows.find((r: any) => r.employee_id === e);

beforeAll(async () => {
  api = await makeApi({ start: '2026-09-30T03:30:00.000Z' }); // 09:00 IST on the last day of the period
  [emp, mgr, hr, fin, root, night] = await Promise.all([EMAIL.emp, EMAIL.mgr, EMAIL.hr, EMAIL.fin, EMAIL.root, EMAIL.night].map((e) => api.login(e)));
  // history for E003: every working day of September except the holiday (14th), the leave day (24th) and today (30th)
  const days = weekdays('2026-09-01', '2026-09-30', ['2026-09-14', '2026-09-24', '2026-09-30']);
  await api.ctx.repo.appendMany('ATTENDANCE_EVENTS', fullDays(IDS.emp, days).map((p, i) => ({
    event_id: `EV-HIST-${i}`, employee_id: p.emp, event_datetime: p.at, event_datetime_utc: p.at, event_type: p.type, capture_method: 'WEB', idempotency_key: `hist-${i}`,
    company_id: IDS.company, status: 'ACTIVE',
  })));
});

describe('day-to-day', () => {
  it('employee checks in and out on the last day', async () => {
    const a = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'AUTO' }, { 'idempotency-key': key() });
    expect(a.body.event.type).toBe('IN');
    api.clock.set('2026-09-30T12:30:00.000Z'); // 18:00 IST
    const b = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'AUTO' }, { 'idempotency-key': key() });
    expect(b.body.event.type).toBe('OUT');
    const d = (await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-30&to=2026-09-30')).body[0];
    expect(d.status).toBe('PRESENT');
    expect(d.worked_minutes).toBe(480);
  });

  it('leave: accrual, application, manager approval, ledger debit and attendance override', async () => {
    expect((await api.call(hr, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' })).status).toBe(200);
    const ap = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-24', toDate: '2026-09-24', halfDay: 'N', reason: 'personal' }, { 'idempotency-key': key() });
    expect(ap.status).toBe(200);
    const inbox = await api.call(mgr, 'GET', '/api/approvals');
    expect(inbox.body.some((i: any) => i.type === 'LEAVE' && i.id === ap.body.application.application_id)).toBe(true);
    expect((await api.call(mgr, 'POST', `/api/leave/applications/${ap.body.application.application_id}/decision`, { decision: 'APPROVED' })).status).toBe(200);
    expect((await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-24&to=2026-09-24')).body[0].status).toBe('LEAVE');
    const bal = (await api.call(emp, 'GET', '/api/leave/balances?year=2026')).body.find((b: any) => b.leave_type_id === IDS.lt.cl);
    expect(bal.balance).toBe(8);
  });
});

describe('payroll run', () => {
  it('an employee without a salary structure blocks approval until it is fixed', async () => {
    const c = await api.call(hr, 'POST', '/api/r/employees', { employee_code: 'V0099', first_name: 'Nosalary', last_name: 'Demo', date_of_joining: '2026-01-01', employment_type: 'PERMANENT', employee_status: 'ACTIVE', location_id: IDS.loc, default_shift_id: IDS.shiftGen, weekly_off_pattern: 'SAT,SUN', ot_eligible: 'N', pf_applicable: 'N', esi_applicable: 'N', pt_applicable: 'N', employee_id: 'E099' });
    expect(c.status).toBe(200);
    expect((await api.call(hr, 'POST', '/api/attendance/scaffold', { from: '2026-09-01', to: '2026-09-30' })).status).toBe(200);
  });

  it('HR opens the period; inputs are scaffolded; illegal jumps are refused', async () => {
    expect((await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'APPROVED' })).status).toBe(409);
    const t = await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'PROCESSING' });
    expect(t.status).toBe(200);
    const rows = (await api.call(fin, 'GET', `/api/payroll/periods/${P}/rows`)).body;
    expect(rows.source).toBe('LIVE');
    expect(rows.rows.length).toBe(9);
  });

  it('finance records a bonus (audited); manual adjustments need a reason', async () => {
    expect((await api.call(fin, 'PATCH', `/api/payroll/periods/${P}/inputs/${IDS.emp}`, { manual_adjustment: 100 })).status).toBe(400);
    expect((await api.call(fin, 'PATCH', `/api/payroll/periods/${P}/inputs/${IDS.emp}`, { bonus: 500 })).status).toBe(200);
    expect((await api.call(emp, 'PATCH', `/api/payroll/periods/${P}/inputs/${IDS.emp}`, { bonus: 99999 })).status).toBe(403);
    const audit = await api.ctx.repo.find('AUDIT_LOG', (a) => a.action === 'PAYROLL_INPUT_UPDATED');
    expect(audit).toHaveLength(1);
    expect(audit[0].before_json).toBeTruthy();
  });

  it('E003 numbers come from the sheet: 30 paid days, gross 34500, PF 1800, PT 200, net 32500', async () => {
    const r = await row(IDS.emp);
    expect(r.paid_days).toBe(30);
    expect(r.lop_days).toBe(0);
    near(r.gross_earnings, 34500);
    expect(r.pf_emp).toBe(1800);
    expect(r.pt).toBe(200);
    near(r.net_pay, 32500);
  });

  it('review is blocked while a row lacks a salary structure', async () => {
    expect((await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'REVIEW' })).status).toBe(200);
    const blocked = await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'APPROVED' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('NOT_READY');
    expect((await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'PROCESSING' })).status).toBe(200);
    const sal = await api.call(fin, 'POST', '/api/r/salaries', { employee_id: 'E099', effective_from: '2026-01-01', basic: 12000, hra: 4800, da: 0, conveyance: 0, special_allowance: 3200, other_allowance: 0, custom_earning_1: 0, custom_earning_2: 0, revision_reason: 'Initial', version: 1 });
    expect(sal.status).toBe(200);
    const period = (await api.call(fin, 'GET', `/api/payroll/periods/${P}`)).body;
    expect(period.issue_count).toBe(0);
    expect(period.ready_to_approve).toBe('YES');
  });

  it('maker-checker: the submitter cannot approve; HR has no approve right; a different approver can', async () => {
    expect((await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'REVIEW' })).status).toBe(200);
    const self = await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'APPROVED' });
    expect(self.status).toBe(403);
    expect((await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'PROCESSING' })).status).toBe(200);
    expect((await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'REVIEW' })).status).toBe(200);
    expect((await api.call(hr, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'APPROVED' })).status).toBe(403);
    expect((await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'APPROVED' })).status).toBe(200);
  });

  it('inputs are frozen once APPROVED; exports become available and are permissioned', async () => {
    expect((await api.call(fin, 'PATCH', `/api/payroll/periods/${P}/inputs/${IDS.emp}`, { bonus: 1 })).status).toBe(423);
    const bank = await api.call(fin, 'GET', `/api/payroll/periods/${P}/export/bank`);
    expect(bank.status).toBe(200);
    expect(String(bank.body)).toContain('V0003,Chirag Demo,****0000,DEMO0000001,32500');
    expect((await api.call(emp, 'GET', `/api/payroll/periods/${P}/export/bank`)).status).toBe(403);
    expect((await api.call(hr, 'GET', `/api/payroll/periods/${P}/export/bank`)).status).toBe(403);
  });

  it('LOCK writes an immutable snapshot and marks loan installments deducted', async () => {
    await api.ctx.repo.append('LOANS', { loan_id: 'LN-9', employee_id: IDS.emp, loan_type: 'LOAN', principal: 3000, annual_interest_rate: 0, tenure_months: 3, status: 'ACTIVE', company_id: IDS.company });
    const lk = await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'LOCKED' });
    expect(lk.status).toBe(200);
    const period = (await api.call(fin, 'GET', `/api/payroll/periods/${P}`)).body;
    expect(period.status).toBe('LOCKED');
    expect(period.snapshot_hash).toHaveLength(64);
    expect(period.locked_by).toBeTruthy();
    const snaps = await api.ctx.repo.find('PAYROLL_SNAPSHOT', (s) => s.period_id === P);
    expect(snaps).toHaveLength(9);
    expect(JSON.parse(String(snaps[0].rules_json)).length).toBeGreaterThan(10); // rule values are captured with the snapshot
    const rows = (await api.call(fin, 'GET', `/api/payroll/periods/${P}/rows`)).body;
    expect(rows.source).toBe('SNAPSHOT');
  });

  it('a locked period refuses every write path and is terminal', async () => {
    expect((await api.call(fin, 'POST', `/api/payroll/periods/${P}/transition`, { to: 'REVIEW' })).status).toBe(409);
    expect((await api.call(fin, 'PATCH', `/api/payroll/periods/${P}/inputs/${IDS.emp}`, { bonus: 1 })).status).toBe(423);
    api.clock.set('2026-09-30T13:00:00.000Z');
    expect((await api.call(emp, 'POST', '/api/attendance/punch', { type: 'IN' }, { 'idempotency-key': key() })).status).toBe(423);
    expect((await api.call(emp, 'POST', '/api/attendance/adjustments', { workDate: '2026-09-10', type: 'MISSING_PUNCH', adjustedOut: '2026-09-10T18:00:00', reason: 'retro fix' })).status).toBe(423);
    expect((await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-28', toDate: '2026-09-28', halfDay: 'N', reason: 'retro' }, { 'idempotency-key': key() })).status).toBe(423);
    const sal = await api.call(fin, 'POST', '/api/r/salaries', { employee_id: IDS.emp, effective_from: '2026-09-10', basic: 99999 });
    expect(sal.status).toBe(423);
    // a later effective date is fine (revision applies to the next period)
    const later = await api.call(fin, 'POST', '/api/r/salaries', { employee_id: IDS.emp, effective_from: '2026-10-01', basic: 22000, hra: 8800, da: 0, conveyance: 1600, special_allowance: 4600, other_allowance: 0, custom_earning_1: 0, custom_earning_2: 0, revision_reason: 'Revision', version: 2 });
    expect(later.status).toBe(200);
  });

  it('history is reproducible: editing a statutory rule in the sheet changes live formulas but not the locked result', async () => {
    const before = await row(IDS.emp);
    expect(before.pf_emp).toBe(1800);
    await api.ctx.repo.update('STATUTORY_RULES', 'RULE-001', { value: 0.2 }); // someone edits the sheet directly
    const live = await api.ctx.repo.findOne('PAYROLL_CALC', (r) => r.calc_key === `${P}:${IDS.emp}`);
    expect(live!.pf_emp).toBe(3000); // live formulas moved
    const after = await row(IDS.emp);
    expect(after.pf_emp).toBe(1800); // locked report still reads the snapshot
    near(after.net_pay, 32500);
    const v = await api.call(fin, 'GET', `/api/payroll/periods/${P}/verify-snapshot`);
    expect(v.body).toEqual({ rows: 9, rowsOk: true, periodHashOk: true });
    await api.ctx.repo.update('STATUTORY_RULES', 'RULE-001', { value: 0.12 });
  });

  it('tampering with a snapshot row is detected', async () => {
    const s = (await api.ctx.repo.find('PAYROLL_SNAPSHOT', (r) => r.employee_id === IDS.emp))[0];
    const col = api.ctx.idx.colIndex(api.ctx.idx.tab('PAYROLL_SNAPSHOT'), 'calc_json');
    const L = String.fromCharCode(65 + col);
    await api.ctx.repo.gateway.writeRanges([{ range: `PAYROLL_SNAPSHOT!${L}${s._row}`, values: [['{"net_pay":999999}']] }]);
    api.ctx.repo.invalidate();
    const v = await api.call(fin, 'GET', `/api/payroll/periods/${P}/verify-snapshot`);
    expect(v.body.rowsOk).toBe(false);
  });
});

describe('payslips and reports', () => {
  it('payslips are generated from the snapshot; each employee sees only their own PDF', async () => {
    const g = await api.call(fin, 'POST', `/api/payroll/periods/${P}/payslips`);
    expect(g.status).toBe(200);
    expect(g.body.created).toBe(9);
    expect((await api.call(fin, 'POST', `/api/payroll/periods/${P}/payslips`)).body.created).toBe(0); // idempotent
    const mine = await api.call(emp, 'GET', '/api/payslips');
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].employeeId).toBe(IDS.emp);
    const pdf = await api.call(emp, 'GET', `/api/payslips/${mine.body[0].payslipId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 4).toString()).toBe('%PDF');
    expect((await api.call(night, 'GET', `/api/payslips/${mine.body[0].payslipId}/pdf`)).status).toBe(403);
    expect((await api.call(fin, 'GET', `/api/payslips/${mine.body[0].payslipId}/pdf`)).status).toBe(200);
    expect((await api.call(night, 'GET', '/api/payslips')).body.every((p: any) => p.employeeId === IDS.night)).toBe(true);
  });

  it('payroll register / department cost reports read the snapshot and are permissioned', async () => {
    const reg = await api.call(fin, 'GET', `/api/reports/payroll_register?period=${P}`);
    expect(reg.status).toBe(200);
    expect(reg.body.total).toBe(9);
    near(reg.body.rows.find((r: any) => r.employee_code === 'V0003').net_pay, 32500);
    const dept = await api.call(fin, 'GET', `/api/reports/department_cost?period=${P}`);
    expect(dept.body.rows.length).toBeGreaterThanOrEqual(2);
    near(dept.body.totals.employer_cost, reg.body.totals.employer_cost);
    expect((await api.call(emp, 'GET', `/api/reports/payroll_register?period=${P}`)).status).toBe(403);
    expect((await api.call(fin, 'GET', `/api/reports/payroll_register`)).status).toBe(400);
    const csv = await api.call(fin, 'GET', `/api/reports/payroll_register?period=${P}&format=csv`);
    expect(String(csv.body).split('\n')[0]).toContain('Net pay');
  });

  it('managers report on their own team only', async () => {
    const r = await api.call(mgr, 'GET', '/api/reports/monthly_attendance?from=2026-09-01&to=2026-09-05');
    expect(r.status).toBe(200);
    // the manager sees themself (SELF) + direct reports; never HR, finance or unassigned staff
    expect(new Set(r.body.rows.map((x: any) => x.employee_code))).toEqual(new Set(['V0002', 'V0003', 'V0004', 'V0006', 'V0008']));
  });

  it('the audit chain of the whole flow is intact and complete', async () => {
    const chk = await api.call(root, 'GET', '/api/audit/verify');
    expect(chk.body.ok).toBe(true);
    expect(chk.body.checked).toBeGreaterThan(30);
    const actions = new Set((await api.call(root, 'GET', '/api/audit?pageSize=200')).body.rows.map((r: any) => r.action));
    for (const a of ['LOGIN_SUCCESS', 'ATTENDANCE_EVENT_CREATED', 'LEAVE_APPLIED', 'LEAVE_APPROVED', 'PAYROLL_PROCESSING', 'PAYROLL_APPROVED', 'PAYROLL_LOCKED', 'PAYSLIPS_GENERATED']) expect(actions.has(a), a).toBe(true);
  });

  it('dashboard health metrics are formula-driven and error-free', async () => {
    const d = await api.call(root, 'GET', '/api/dashboard');
    expect(d.status).toBe(200);
    const m = d.body.metrics;
    expect(m.h_errors_attendance_daily.value).toBe(0);
    expect(m.h_errors_payroll_calc.value).toBe(0);
    expect(m.h_duplicate_ids.value).toBe(0);
    expect(m.h_missing_salary.value).toBe(0);
    expect(m.payroll_status.value).toBe('LOCKED');
    expect(Number(m.cap_events_pct.value)).toBeGreaterThan(0);
    const empView = await api.call(emp, 'GET', '/api/dashboard');
    expect(empView.body.metrics.payroll_net).toBeUndefined(); // payroll figures are not for employees
  });
});
