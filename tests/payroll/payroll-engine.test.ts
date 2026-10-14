import { beforeAll, describe, expect, it } from 'vitest';
import { Env, IDS, addLeave, bulkPunches, calcRow, fullDays, makeEnv, punch, scaffold, scaffoldPayroll, serialOf, weekdays } from '../helpers';

/**
 * Payroll = formulas. September 2026 (30 days). Sat/Sun off; 14 Sep holiday.
 * E003: basic 20000, HRA 8000, conveyance 1600, special 4400 (gross 34000); PF yes, ESI no, PT yes, OT eligible.
 */
let env: Env;
const near = (a: unknown, b: number) => expect(Number(a)).toBeCloseTo(b, 2);

beforeAll(async () => {
  env = await makeEnv(60, { ATTENDANCE_EVENTS: 320, ATTENDANCE_DAILY: 320 });
  await scaffold(env, '2026-09-01', '2026-09-30');

  const workdays = weekdays('2026-09-01', '2026-09-30', ['2026-09-14']);
  // E003: every working day except 30 Sep (1 LOP day); 15 Sep runs until 20:00 (overtime)
  const e003 = workdays.filter((d) => d !== '2026-09-30' && d !== '2026-09-15');
  const punches = [
    ...fullDays(IDS.emp, e003),
    ...fullDays(IDS.emp, ['2026-09-15'], '09:00:00', '20:00:00'),
    // joiner: all working days from 16 Sep
    ...fullDays(IDS.joiner, weekdays('2026-09-16', '2026-09-30', ['2026-09-14'])),
    // leaver: all working days up to exit 20 Sep
    ...fullDays(IDS.leaver, weekdays('2026-09-01', '2026-09-20', ['2026-09-14'])),
  ];
  await bulkPunches(env, punches);

  await scaffoldPayroll(env);

  // manual inputs (bonus, deduction) for E003
  await env.repo.update('PAYROLL_INPUTS', `PI-${IDS.period}-${IDS.emp}`, { bonus: 1000, other_deduction: 100 });
  // approved OT of 60 minutes on 15 Sep (calc says 90)
  await env.repo.append('OVERTIME', {
    ot_id: 'OT-1', employee_id: IDS.emp, work_date: '2026-09-15', day_type: 'REGULAR', requested_minutes: 90, approver_employee_id: IDS.mgr,
    approved_minutes: 60, status: 'APPROVED', company_id: IDS.company,
  });
  // loan (EMI 1000) + advance (recovery 1000) scheduled for this period
  await env.repo.append('LOANS', { loan_id: 'LN-1', employee_id: IDS.emp, loan_type: 'LOAN', principal: 12000, annual_interest_rate: 0, tenure_months: 12, status: 'ACTIVE', company_id: IDS.company });
  await env.repo.append('LOANS', { loan_id: 'AD-1', employee_id: IDS.emp, loan_type: 'ADVANCE', principal: 5000, annual_interest_rate: 0, tenure_months: 5, status: 'ACTIVE', company_id: IDS.company });
  await env.repo.appendMany('LOAN_SCHEDULE', [
    { schedule_id: 'LS-1', loan_id: 'LN-1', employee_id: IDS.emp, loan_type: 'LOAN', installment_no: 1, due_period_id: IDS.period, status: 'SCHEDULED', company_id: IDS.company },
    { schedule_id: 'LS-2', loan_id: 'AD-1', employee_id: IDS.emp, loan_type: 'ADVANCE', installment_no: 1, due_period_id: IDS.period, status: 'SCHEDULED', company_id: IDS.company },
  ]);
  await env.repo.append('REIMBURSEMENTS', { reimbursement_id: 'RB-1', employee_id: IDS.emp, period_id: IDS.period, amount: 750, status: 'APPROVED', company_id: IDS.company });
});

describe('E003 full computation (LOP, OT, bonus, loan, advance, reimbursement)', () => {
  it('attendance feeds payroll inputs', async () => {
    const pi = await env.repo.findOne('PAYROLL_INPUTS', (r) => r.employee_id === IDS.emp);
    expect(pi!.window_days).toBe(30);
    expect(pi!.att_rows).toBe(30);
    expect(pi!.paid_days).toBe(29);
    expect(pi!.lop_days).toBe(1);
    expect(pi!.unresolved_exceptions).toBe(0);
    expect(pi!.loan_emi).toBe(1000);
    expect(pi!.advance_recovery).toBe(1000);
    expect(pi!.reimbursement).toBe(750);
  });

  it('gross, statutory and net pay match the hand calculation', async () => {
    const c = await calcRow(env, IDS.emp);
    expect(c.paid_days).toBe(29);
    near(c.earned_basic, 19333.33);
    near(c.earned_hra, 7733.33);
    near(c.earned_fixed_total, 32866.66);
    near(c.ot_hourly, 83.3333);
    expect(c.ot_reg_min).toBe(60); // MIN(approved 60, calculated 90)
    near(c.ot_amount, 166.67);
    near(c.gross_earnings, 34033.33);
    expect(c.pf_emp).toBe(1800); // basic earned 19333 capped at 15000 x 12%
    expect(c.pf_er).toBe(1800);
    expect(c.esi_emp).toBe(0);
    expect(c.pt).toBe(200);
    expect(c.loan_emi).toBe(1000);
    expect(c.advance_recovery).toBe(1000);
    near(c.total_deductions, 4100);
    near(c.net_pay, 30683.33);
    near(c.employer_cost, 34033.33 + 750 + 1800);
    expect(c.check_status).toBe('OK');
  });
});

describe('mid-month joiner and exit', () => {
  it('joiner: window 16-30 Sep, paid 15/30, ESI eligible, no PT below slab', async () => {
    const pi = await env.repo.findOne('PAYROLL_INPUTS', (r) => r.employee_id === IDS.joiner);
    expect(pi!.window_days).toBe(15);
    expect(pi!.att_rows).toBe(15);
    const c = await calcRow(env, IDS.joiner);
    expect(c.paid_days).toBe(15);
    near(c.earned_fixed_total, 10000);
    expect(c.esi_emp).toBe(75); // ROUNDUP(10000 x 0.75%)
    expect(c.esi_er).toBe(325);
    expect(c.pf_emp).toBe(600);
    expect(c.pt).toBe(0);
    near(c.net_pay, 10000 - 600 - 75);
    expect(c.check_status).toBe('OK');
  });

  it('leaver: window 1-20 Sep, paid 20/30', async () => {
    const c = await calcRow(env, IDS.leaver);
    expect(c.paid_days).toBe(20);
    near(c.earned_basic, (22000 * 20) / 30);
    expect(c.check_status).toBe('OK');
  });
});

describe('salary revision effective mid-period', () => {
  it('blends old and new rates by days (15 + 15) before proration', async () => {
    const c = await calcRow(env, IDS.night);
    expect(c.rev_date).toBe("2026-09-16");
    expect(c.days_a).toBe(15);
    expect(c.days_b).toBe(15);
    near(c.monthly_basic, 22000);
    near(c.monthly_hra, 8800);
    near(c.monthly_contract_gross, 22000 + 8800 + 1600 + 4600);
  });

  it('arrears are an explicit approved input added to gross', async () => {
    await env.repo.update('PAYROLL_INPUTS', `PI-${IDS.period}-${IDS.night}`, { arrears: 300, manual_adjustment: -50, manual_adjustment_reason: 'test' });
    const c = await calcRow(env, IDS.night);
    near(c.gross_earnings, Number(c.earned_fixed_total) + Number(c.ot_amount) + 300 - 50);
  });
});

describe('control checks', () => {
  it('missing salary structure is reported, not silently zero', async () => {
    await env.repo.append('EMPLOYEES', {
      employee_id: 'E099', employee_code: 'V0099', first_name: 'Nosalary', last_name: 'Demo', date_of_joining: '2026-01-01', employment_type: 'PERMANENT', employee_status: 'ACTIVE',
      default_shift_id: IDS.shiftGen, weekly_off_pattern: 'SAT,SUN', ot_eligible: 'N', pf_applicable: 'Y', esi_applicable: 'N', pt_applicable: 'N', location_id: IDS.loc, status: 'ACTIVE', company_id: IDS.company,
    });
    await scaffold(env, '2026-09-01', '2026-09-30', ['E099']);
    await scaffoldPayroll(env);
    const c = await calcRow(env, 'E099');
    expect(c.check_status).toBe('NO_SALARY_STRUCTURE');
    const dash = await env.repo.findOne('DASHBOARD_DATA', (r) => r.metric_key === 'h_missing_salary');
    expect(Number(dash!.value)).toBeGreaterThanOrEqual(1);
  });

  it('unresolved attendance exceptions block payroll until resolved or waived', async () => {
    await punch(env, IDS.oper, 'IN', '2026-09-02T09:00:00'); // no OUT
    let c = await calcRow(env, IDS.oper);
    expect(c.check_status).toBe('UNRESOLVED_EXCEPTIONS');
    await env.repo.append('ATTENDANCE_EXCEPTIONS', {
      exception_id: 'EXC-1', attendance_key: `${IDS.oper}:${serialOf("2026-09-02")}`, employee_id: IDS.oper, work_date: '2026-09-02', exception_type: 'MISSING_PUNCH', status: 'WAIVED', company_id: IDS.company,
    });
    c = await calcRow(env, IDS.oper);
    expect(c.check_status).toBe('OK');
  });

  it('control tab rolls up totals and readiness', async () => {
    const pc = await env.repo.getByKey('PAYROLL_CONTROL', IDS.period);
    expect(pc!.employee_rows).toBeGreaterThanOrEqual(8);
    expect(Number(pc!.total_net)).toBeGreaterThan(30000);
    expect(pc!.days_in_period).toBe(30);
    expect(pc!.ready_to_approve).toBe('NO'); // E099 has no salary
  });

  it('there are no formula errors anywhere in the payroll chain', async () => {
    for (const tab of ['PAYROLL_INPUTS', 'PAYROLL_CALC', 'STATUTORY_CALC', 'PAYROLL_CONTROL', 'ATTENDANCE_DAILY', 'LEAVE_BALANCES']) {
      const rows = await env.repo.readAll(tab);
      const errs = rows.flatMap((r) => Object.entries(r).filter(([, v]) => typeof v === 'string' && /^#(REF|VALUE|N\/A|DIV|NAME|NUM|CYCLE|ERROR)/.test(v)));
      expect(errs, tab).toEqual([]);
    }
  });
});

describe('off-cycle run', () => {
  it('bonus-only run ignores attendance and salary, taxes via manual TDS', async () => {
    await env.repo.append('PAYROLL_CONTROL', {
      period_id: 'PR-OC-2026-09', period_label: 'Off-cycle bonus', period_start: '2026-09-01', period_end: '2026-09-30', run_type: 'OFF_CYCLE', version: 1, status: 'OPEN', company_id: IDS.company,
    });
    await scaffoldPayroll(env, 'PR-OC-2026-09');
    await env.repo.update('PAYROLL_INPUTS', `PI-PR-OC-2026-09-${IDS.emp}`, { bonus: 5000, tds_manual_flag: 'Y', tds_manual_amount: 500 });
    const c = await calcRow(env, IDS.emp, 'PR-OC-2026-09');
    expect(c.run_flag).toBe(0);
    expect(c.paid_days).toBe(0);
    near(c.gross_earnings, 5000);
    expect(c.pf_emp).toBe(0);
    expect(c.pt).toBe(0);
    expect(c.tds).toBe(500);
    near(c.net_pay, 4500);
    expect(c.check_status).toBe('OK');
  });
});

describe('locked periods', () => {
  it('a period is flagged locked in attendance and approvals recorded after lock become violations', async () => {
    await scaffold(env, '2026-08-10', '2026-08-10', [IDS.emp]);
    const d = await env.repo.findOne('ATTENDANCE_DAILY', (r) => r.employee_id === IDS.emp && r.work_date === '2026-08-10');
    expect(d!.is_period_locked).toBe(1);
    await env.repo.append('ATTENDANCE_ADJUSTMENTS', {
      adjustment_id: 'ADJ-L', employee_id: IDS.emp, work_date: '2026-08-10', adjustment_type: 'TIME_CORRECTION', adjusted_in: '2026-08-10T09:00:00', adjusted_out: '2026-08-10T18:00:00',
      reason: 'late fix', status: 'APPROVED', decided_at: '2026-09-05T09:00:00', company_id: IDS.company,
    });
    const adj = await env.repo.getByKey('ATTENDANCE_ADJUSTMENTS', 'ADJ-L');
    expect(adj!.is_period_locked).toBe(1);
    expect(adj!.locked_violation).toBe(1);
  });
});

describe('leave interplay with payroll', () => {
  it('approved paid leave removes LOP', async () => {
    await addLeave(env, IDS.emp, IDS.lt.cl, '2026-09-30', '2026-09-30');
    const pi = await env.repo.findOne('PAYROLL_INPUTS', (r) => r.employee_id === IDS.emp && r.period_id === IDS.period);
    expect(pi!.paid_days).toBe(30);
    expect(pi!.lop_days).toBe(0);
  });
});
