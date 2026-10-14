import { COMPONENT_SEEDS, ROLE_ROWS, STATUTORY_RULE_SEEDS, SYSTEM_CONFIG_DEFAULTS, ConfigRow } from '@nutex/formula-specs';
import { dateTimeToSerial, dateToSerial } from '@nutex/sheet-connector';

/** Synthetic demo data only. No real personal information. */
export const IDS = {
  company: 'CMP-NUTEX',
  loc: 'LOC-HQ', loc2: 'LOC-PUNE',
  shiftGen: 'SHF-GEN', shiftNight: 'SHF-NIGHT', shiftFlex: 'SHF-FLEX', shiftSplit: 'SHF-SPLIT',
  hr: 'E001', mgr: 'E002', emp: 'E003', night: 'E004', joiner: 'E005', leaver: 'E006', fin: 'E007', oper: 'E008',
  period: 'PR-2026-09', periodLocked: 'PR-2026-08',
  lt: { cl: 'LT-CL', sl: 'LT-SL', el: 'LT-EL', lop: 'LT-LOP', wfh: 'LT-WFH', od: 'LT-OD', comp: 'LT-COMP' },
} as const;

const NOW = '2026-09-01T00:00:00';
const AUD = (source = 'SEED') => ({ company_id: IDS.company, created_at: NOW, created_by: 'seed', updated_at: NOW, updated_by: 'seed', source, request_id: 'seed', status: 'ACTIVE', notes: '' });

export interface SeedUser { user_id: string; employee_id: string; email: string; display_name: string; role: string; location_scope: string }

export const SEED_USERS: SeedUser[] = [
  { user_id: 'U001', employee_id: IDS.hr, email: 'hr.admin@demo.nutex.example', display_name: 'Aarav Demo (HR Admin)', role: 'HR_ADMIN', location_scope: IDS.loc },
  { user_id: 'U002', employee_id: IDS.mgr, email: 'manager@demo.nutex.example', display_name: 'Bhavna Demo (Manager)', role: 'MANAGER', location_scope: IDS.loc },
  { user_id: 'U003', employee_id: IDS.emp, email: 'employee@demo.nutex.example', display_name: 'Chirag Demo (Employee)', role: 'EMPLOYEE', location_scope: IDS.loc },
  { user_id: 'U004', employee_id: IDS.night, email: 'night.shift@demo.nutex.example', display_name: 'Divya Demo (Night shift)', role: 'EMPLOYEE', location_scope: IDS.loc },
  { user_id: 'U007', employee_id: IDS.fin, email: 'finance@demo.nutex.example', display_name: 'Gita Demo (Finance)', role: 'FINANCE_PAYROLL', location_scope: 'ALL' },
  { user_id: 'U008', employee_id: IDS.oper, email: 'operator@demo.nutex.example', display_name: 'Harsh Demo (Site clerk)', role: 'ATTENDANCE_OPERATOR', location_scope: IDS.loc },
  { user_id: 'U009', employee_id: IDS.hr, email: 'super.admin@demo.nutex.example', display_name: 'Super Admin (Demo)', role: 'SUPER_ADMIN', location_scope: 'ALL' },
  { user_id: 'U010', employee_id: IDS.emp, email: 'hr.pune@demo.nutex.example', display_name: 'HR Pune Demo', role: 'HR_ADMIN', location_scope: IDS.loc2 },
];

type Rows = Record<string, unknown>[];

function cfgRows(rows: ConfigRow[]): Rows {
  return rows.map((r) => ({
    key: r.key,
    value: r.type === 'date' && typeof r.value === 'string' ? dateToSerial(r.value) : r.type === 'datetime' && typeof r.value === 'string' ? dateTimeToSerial(r.value) : r.value,
    type: r.type, description: r.description, updated_at: NOW, updated_by: 'seed',
  }));
}

export function buildSeed(passwordHashes: Record<string, string> = {}): Record<string, Rows> {
  const emp = (id: string, code: string, first: string, join: string, o: Record<string, unknown> = {}) => ({
    employee_id: id, employee_code: code, first_name: first, last_name: 'Demo', email: `${first.toLowerCase()}@demo.nutex.example`, phone: '',
    date_of_joining: join, employment_type: 'PERMANENT', employee_status: 'ACTIVE', department_id: 'DEP-OPS', designation_id: 'DSG-EXEC', location_id: IDS.loc,
    manager_employee_id: IDS.mgr, default_shift_id: IDS.shiftGen, weekly_off_pattern: 'SAT,SUN', ot_eligible: 'N', pf_applicable: 'Y', esi_applicable: 'N', pt_applicable: 'Y',
    cost_center_id: 'CC-100', bank_account_ref: '****0000', bank_ifsc: 'DEMO0000001', ...AUD(), ...o,
  });

  const sal = (id: string, emp_id: string, from: string, basic: number, hra: number, conv: number, special: number, o: Record<string, unknown> = {}) => ({
    salary_id: id, employee_id: emp_id, effective_from: from, basic, hra, da: 0, conveyance: conv, special_allowance: special, other_allowance: 0,
    custom_earning_1: 0, custom_earning_2: 0, revision_reason: 'Initial', version: 1, ...AUD(), ...o,
  });

  const lb = (i: number, e: string, t: string) => ({ balance_id: `LB-${e}-${t}-2026`, employee_id: e, leave_type_id: t, leave_year: 2026, ...AUD() });
  void lb;
  const balances: Rows = [];
  const opening: Rows = [];
  let n = 1;
  const emps = [IDS.hr, IDS.mgr, IDS.emp, IDS.night, IDS.joiner, IDS.leaver, IDS.fin, IDS.oper];
  for (const e of emps) {
    for (const t of [IDS.lt.cl, IDS.lt.sl, IDS.lt.el, IDS.lt.comp, IDS.lt.lop, IDS.lt.wfh, IDS.lt.od]) {
      balances.push({ balance_id: `LB-${e}-${t}-2026`, employee_id: e, leave_type_id: t, leave_year: 2026, ...AUD() });
    }
    // opening balance for earned leave carried into 2026 (ledger row, not a typed balance)
    if (e !== IDS.joiner) opening.push({ txn_id: `LTX-${String(n++).padStart(5, '0')}`, employee_id: e, leave_type_id: IDS.lt.el, leave_year: 2026, txn_type: 'OPENING', txn_date: '2026-01-01', days: 6, reference_id: 'OPENING', idempotency_key: `opening-${e}`, remarks: 'Carry-forward opening', ...AUD() });
  }

  const dailyCfg = (id: string, name: string, cat: string, paid: string, o: Record<string, unknown> = {}) => ({
    leave_type_id: id, code: id.replace('LT-', ''), name, category: cat, is_paid: paid, requires_approval: 'Y', allow_half_day: 'Y', count_holidays_weekoffs: 'N',
    allow_negative: 'N', max_negative_days: 0, min_notice_days: 0, max_consecutive_days: 30, ...AUD(), ...o,
  });

  const policy = (id: string, type: string, emp_type: string, quota: number, perMonth: number, method: string, o: Record<string, unknown> = {}) => ({
    policy_id: id, leave_type_id: type, employment_type: emp_type, annual_quota: quota, accrual_days_per_month: perMonth, accrual_method: method, prorate_joiners: 'Y',
    probation_lock: 'N', max_carry_forward: 0, max_encashable: 0, effective_from: '2026-01-01', ...AUD(), ...o,
  });

  return {
    SYSTEM_CONFIG: cfgRows(SYSTEM_CONFIG_DEFAULTS),
    ROLES: ROLE_ROWS,
    DEPARTMENTS: [
      { department_id: 'DEP-HR', code: 'HR', name: 'Human Resources', ...AUD() },
      { department_id: 'DEP-OPS', code: 'OPS', name: 'Operations', ...AUD() },
      { department_id: 'DEP-FIN', code: 'FIN', name: 'Finance', ...AUD() },
    ],
    DESIGNATIONS: [
      { designation_id: 'DSG-EXEC', name: 'Executive', grade: 'G3', level: 3, ...AUD() },
      { designation_id: 'DSG-MGR', name: 'Manager', grade: 'G5', level: 5, ...AUD() },
    ],
    LOCATIONS: [
      { location_id: IDS.loc, name: 'NUTEX HQ (Demo)', address: 'Demo Street 1', city: 'Mumbai', state: 'Maharashtra', timezone: 'Asia/Kolkata', latitude: 19.076, longitude: 72.8777, geofence_radius_m: 250, geofence_required: 'N', ...AUD() },
      { location_id: IDS.loc2, name: 'NUTEX Pune (Demo)', address: 'Demo Street 2', city: 'Pune', state: 'Maharashtra', timezone: 'Asia/Kolkata', latitude: 18.5204, longitude: 73.8567, geofence_radius_m: 250, geofence_required: 'N', ...AUD() },
    ],
    SHIFT_MASTER: [
      { shift_id: IDS.shiftGen, shift_name: 'General 09:00-18:00', shift_type: 'FIXED', start_time: '09:00', end_time: '18:00', break_minutes: 60, grace_in_minutes: 10, grace_out_minutes: 0, full_day_minutes: 480, half_day_minutes: 240, ot_threshold_minutes: 30, is_flexible: 'N', effective_from: '2026-01-01', ...AUD() },
      { shift_id: IDS.shiftNight, shift_name: 'Night 22:00-06:00', shift_type: 'NIGHT', start_time: '22:00', end_time: '06:00', break_minutes: 30, grace_in_minutes: 10, grace_out_minutes: 0, full_day_minutes: 450, half_day_minutes: 225, ot_threshold_minutes: 30, is_flexible: 'N', effective_from: '2026-01-01', ...AUD() },
      { shift_id: IDS.shiftFlex, shift_name: 'Flexible 8h', shift_type: 'FLEXIBLE', start_time: '08:00', end_time: '20:00', break_minutes: 60, grace_in_minutes: 0, grace_out_minutes: 0, full_day_minutes: 480, half_day_minutes: 240, ot_threshold_minutes: 30, is_flexible: 'Y', effective_from: '2026-01-01', ...AUD() },
      { shift_id: IDS.shiftSplit, shift_name: 'Split 08:00-12:00 / 16:00-20:00', shift_type: 'SPLIT', start_time: '08:00', end_time: '20:00', break_minutes: 0, grace_in_minutes: 10, grace_out_minutes: 0, full_day_minutes: 480, half_day_minutes: 240, ot_threshold_minutes: 30, is_flexible: 'N', effective_from: '2026-01-01', ...AUD() },
    ],
    EMPLOYEES: [
      emp(IDS.hr, 'V0001', 'Aarav', '2024-04-01', { department_id: 'DEP-HR', designation_id: 'DSG-MGR', manager_employee_id: '' }),
      emp(IDS.mgr, 'V0002', 'Bhavna', '2024-06-01', { designation_id: 'DSG-MGR', manager_employee_id: '' }),
      emp(IDS.emp, 'V0003', 'Chirag', '2025-01-10', { ot_eligible: 'Y' }),
      emp(IDS.night, 'V0004', 'Divya', '2025-03-01', { ot_eligible: 'Y', default_shift_id: IDS.shiftNight, weekly_off_pattern: 'SUN' }),
      emp(IDS.joiner, 'V0005', 'Esha', '2026-09-16', { employment_type: 'PROBATION', probation_end_date: '2027-03-16', esi_applicable: 'Y' }),
      emp(IDS.leaver, 'V0006', 'Farhan', '2023-02-01', { date_of_exit: '2026-09-20', employee_status: 'NOTICE' }),
      emp(IDS.fin, 'V0007', 'Gita', '2024-01-15', { department_id: 'DEP-FIN', designation_id: 'DSG-MGR', location_id: IDS.loc, manager_employee_id: '' }),
      emp(IDS.oper, 'V0008', 'Harsh', '2025-07-01', {}),
    ],
    USERS: SEED_USERS.map((u) => ({
      ...u, password_hash: passwordHashes[u.email] ?? '', mfa_enabled: 'N', mfa_secret_ref: '', failed_attempts: 0, must_change_password: 'N', ...AUD(), status: 'ACTIVE',
    })),
    HOLIDAYS: [
      { holiday_id: 'HOL-001', holiday_date: '2026-09-14', name: 'Demo Company Day', holiday_type: 'COMPANY', location_id: 'ALL', ...AUD() },
      { holiday_id: 'HOL-002', holiday_date: '2026-10-02', name: 'Gandhi Jayanti', holiday_type: 'PUBLIC', location_id: 'ALL', ...AUD() },
    ],
    SALARY_COMPONENTS: COMPONENT_SEEDS.map((c, i) => ({
      component_id: `SC-${c.code}`, component_code: c.code, name: c.name, component_type: c.type, taxable: c.taxable, pf_wage: c.pf, esi_wage: c.esi, ot_base: c.ot,
      display_order: i + 1, effective_from: '2020-01-01', ...AUD(),
    })),
    EMPLOYEE_SALARY: [
      sal('SAL-E001-1', IDS.hr, '2024-04-01', 30000, 15000, 1600, 13400),
      sal('SAL-E002-1', IDS.mgr, '2024-06-01', 26000, 13000, 1600, 9400),
      sal('SAL-E003-1', IDS.emp, '2025-01-10', 20000, 8000, 1600, 4400),
      sal('SAL-E004-1', IDS.night, '2025-03-01', 20000, 8000, 1600, 4400),
      sal('SAL-E004-2', IDS.night, '2026-09-16', 24000, 9600, 1600, 4800, { revision_reason: 'Annual revision', version: 2 }),
      sal('SAL-E005-1', IDS.joiner, '2026-09-16', 10000, 4000, 1600, 4400),
      sal('SAL-E006-1', IDS.leaver, '2023-02-01', 22000, 8800, 1600, 5600),
      sal('SAL-E007-1', IDS.fin, '2024-01-15', 28000, 14000, 1600, 10400),
      sal('SAL-E008-1', IDS.oper, '2025-07-01', 15000, 6000, 1600, 3400),
    ],
    STATUTORY_RULES: STATUTORY_RULE_SEEDS.map((r, i) => ({
      rule_id: `RULE-${String(i + 1).padStart(3, '0')}`, rule_code: r.code, description: r.description, value: r.value, unit: r.unit, effective_from: '2020-01-01',
      jurisdiction: 'IN', version: 1, source_note: 'ILLUSTRATIVE DEMO VALUE - verify against current statute / state notification before production', ...AUD(),
    })),
    LEAVE_TYPES: [
      dailyCfg(IDS.lt.cl, 'Casual Leave', 'LEAVE', 'Y'),
      dailyCfg(IDS.lt.sl, 'Sick Leave', 'LEAVE', 'Y'),
      dailyCfg(IDS.lt.el, 'Earned Leave', 'LEAVE', 'Y', { min_notice_days: 3 }),
      dailyCfg(IDS.lt.lop, 'Leave Without Pay', 'LEAVE', 'N', { allow_negative: 'Y', max_negative_days: 365 }),
      dailyCfg(IDS.lt.wfh, 'Work From Home', 'WFH', 'Y'),
      dailyCfg(IDS.lt.od, 'On Duty', 'OD', 'Y'),
      dailyCfg(IDS.lt.comp, 'Compensatory Off', 'COMP_OFF', 'Y'),
    ],
    LEAVE_POLICIES: [
      policy('POL-CL-P', IDS.lt.cl, 'PERMANENT', 12, 1, 'MONTHLY'),
      policy('POL-CL-PR', IDS.lt.cl, 'PROBATION', 6, 0.5, 'MONTHLY'),
      policy('POL-SL-P', IDS.lt.sl, 'PERMANENT', 12, 1, 'ANNUAL_UPFRONT'),
      policy('POL-SL-PR', IDS.lt.sl, 'PROBATION', 6, 0.5, 'ANNUAL_UPFRONT'),
      policy('POL-EL-P', IDS.lt.el, 'PERMANENT', 18, 1.5, 'MONTHLY', { max_carry_forward: 30, max_encashable: 15 }),
      policy('POL-EL-PR', IDS.lt.el, 'PROBATION', 18, 1.5, 'MONTHLY', { probation_lock: 'Y', max_carry_forward: 0, max_encashable: 0 }),
      policy('POL-COMP-P', IDS.lt.comp, 'PERMANENT', 0, 0, 'MANUAL'),
      policy('POL-COMP-PR', IDS.lt.comp, 'PROBATION', 0, 0, 'MANUAL'),
    ],
    LEAVE_BALANCES: balances,
    LEAVE_TRANSACTIONS: opening,
    PAYROLL_CONTROL: [
      { period_id: IDS.periodLocked, period_label: 'August 2026', period_start: '2026-08-01', period_end: '2026-08-31', cutoff_date: '2026-08-28', run_type: 'REGULAR', version: 1, locked_by: 'seed', locked_at: '2026-09-03T10:00:00', ...AUD(), status: 'LOCKED' },
      { period_id: IDS.period, period_label: 'September 2026', period_start: '2026-09-01', period_end: '2026-09-30', cutoff_date: '2026-09-28', run_type: 'REGULAR', version: 1, ...AUD(), status: 'OPEN' },
    ],
  };
}
