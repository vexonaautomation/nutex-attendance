import { TabDef, aud, en, fx, id, inp } from './dsl';

const FRANGE_TABS = [
  'EMPLOYEES', 'ATTENDANCE_EVENTS', 'ATTENDANCE_DAILY', 'LEAVE_APPLICATIONS', 'LEAVE_BALANCES', 'OVERTIME', 'EMPLOYEE_SALARY',
  'PAYROLL_CONTROL', 'PAYROLL_INPUTS', 'PAYROLL_CALC', 'STATUTORY_CALC', 'FULL_FINAL', 'LOANS',
];

type Row = Record<string, string | number>;
const AD = (c: string) => `[ATTENDANCE_DAILY.${c}]`;
const dash = '$CFG(DASHBOARD_DATE)';
const metric = (metric_key: string, label: string, group: string, value: string): Row => ({ metric_key, label, group, value: `=${value}` });

const DASHBOARD_ROWS: Row[] = [
  metric('employees_active', 'Active employees', 'HEADCOUNT', 'COUNTIFS([EMPLOYEES.employee_status],"ACTIVE")'),
  metric('att_present', 'Present (incl. WFH/OD, holiday/week-off work)', 'ATTENDANCE',
    `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"PRESENT")+COUNTIFS(${AD('work_date')},${dash},${AD('status')},"WFH_OD")+COUNTIFS(${AD('work_date')},${dash},${AD('status')},"HOLIDAY_WORK")+COUNTIFS(${AD('work_date')},${dash},${AD('status')},"WEEKOFF_WORK")`),
  metric('att_in_progress', 'Working now (checked in)', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"IN_PROGRESS")`),
  metric('att_half_day', 'Half day', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"HALF_DAY")`),
  metric('att_absent', 'Absent', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"ABSENT")`),
  metric('att_on_leave', 'On leave', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"LEAVE")+COUNTIFS(${AD('work_date')},${dash},${AD('status')},"UNPAID_LEAVE")`),
  metric('att_late', 'Late arrivals', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('late_minutes')},">0")`),
  metric('att_missing_punch', 'Missing punch', 'ATTENDANCE', `COUNTIFS(${AD('work_date')},${dash},${AD('status')},"MISSING_PUNCH")`),
  metric('pending_leave', 'Pending leave / WFH / OD', 'APPROVALS', 'COUNTIFS([LEAVE_APPLICATIONS.status],"PENDING")'),
  metric('pending_adjustments', 'Pending regularisations', 'APPROVALS', 'COUNTIFS([ATTENDANCE_ADJUSTMENTS.status],"PENDING")'),
  metric('pending_overtime', 'Pending overtime', 'APPROVALS', 'COUNTIFS([OVERTIME.status],"PENDING")'),
  metric('pending_expenses', 'Pending expenses', 'APPROVALS', 'COUNTIFS([EXPENSES.status],"PENDING")'),
  metric('pending_timesheets', 'Pending timesheets', 'APPROVALS', 'COUNTIFS([TIMESHEETS.status],"PENDING")'),
  metric('open_exceptions', 'Open attendance exceptions', 'ATTENDANCE', 'COUNTIFS([ATTENDANCE_EXCEPTIONS.status],"OPEN")'),
  metric('payroll_status', 'Active payroll period status', 'PAYROLL', 'IFERROR(INDEX([PAYROLL_CONTROL.status],MATCH($CFG(ACTIVE_PERIOD_ID),[PAYROLL_CONTROL.period_id],0)),"")'),
  metric('payroll_gross', 'Active period gross', 'PAYROLL', 'SUMIFS([PAYROLL_CALC.gross_earnings],[PAYROLL_CALC.period_id],$CFG(ACTIVE_PERIOD_ID))'),
  metric('payroll_net', 'Active period net pay', 'PAYROLL', 'SUMIFS([PAYROLL_CALC.net_pay],[PAYROLL_CALC.period_id],$CFG(ACTIVE_PERIOD_ID))'),
  metric('payroll_employer_cost', 'Active period employer cost', 'PAYROLL', 'SUMIFS([PAYROLL_CALC.employer_cost],[PAYROLL_CALC.period_id],$CFG(ACTIVE_PERIOD_ID))'),
  metric('payroll_issues', 'Active period rows needing attention', 'PAYROLL', 'COUNTIFS([PAYROLL_CALC.period_id],$CFG(ACTIVE_PERIOD_ID),[PAYROLL_CALC.check_status],"<>OK")'),
  ...FRANGE_TABS.map((t) => metric(`h_errors_${t.toLowerCase()}`, `Formula errors in ${t}`, 'HEALTH', `SUMPRODUCT(--ISERROR({FRANGE:${t}}))`)),
  metric('h_duplicate_ids', 'Duplicate / overlapping keys', 'HEALTH',
    'COUNTIFS([EMPLOYEES.dup_code_check],"DUPLICATE*")+COUNTIFS([SHIFT_ROSTER.dup_check],"DUPLICATE*")+COUNTIFS([EMPLOYEE_SALARY.dup_check],"DUPLICATE*")+COUNTIFS([LEAVE_BALANCES.dup_check],"DUPLICATE*")+COUNTIFS([LEAVE_POLICIES.dup_check],"DUPLICATE*")+COUNTIFS([ATTENDANCE_DAILY.dup_check],"DUPLICATE*")+COUNTIFS([PAYROLL_INPUTS.dup_check],"DUPLICATE*")+COUNTIFS([STATUTORY_RULES.overlap_check],"OVERLAP*")'),
  metric('h_missing_salary', 'Payroll rows without salary structure', 'HEALTH', 'COUNTIFS([PAYROLL_CALC.check_status],"NO_SALARY_STRUCTURE")'),
  metric('h_missing_shift', 'Days without a shift', 'HEALTH', `COUNTIFS(${AD('exception_flag')},"NO_SHIFT")`),
  metric('h_unresolved_attendance', 'Unresolved attendance exceptions', 'HEALTH', `SUM(${AD('exception_open')})`),
  metric('h_negative_balances', 'Negative balance exceptions', 'HEALTH', 'SUM([LEAVE_BALANCES.negative_flag])'),
  metric('h_locked_violations', 'Approvals recorded after period lock', 'HEALTH', 'SUM([ATTENDANCE_ADJUSTMENTS.locked_violation])'),
  metric('h_ledger_sign_mismatch', 'Leave ledger sign mismatches', 'HEALTH', 'COUNTIFS([LEAVE_TRANSACTIONS.sign_check],"SIGN_MISMATCH")'),
  metric('h_missing_attendance_rows', 'Payroll rows with missing attendance rows', 'HEALTH', 'COUNTIFS([PAYROLL_INPUTS.input_health],"MISSING_ATTENDANCE_ROWS")'),
  metric('cap_events_pct', 'ATTENDANCE_EVENTS capacity used', 'CAPACITY', 'ROUND(COUNTA([ATTENDANCE_EVENTS.event_id])/ROWS([ATTENDANCE_EVENTS.event_id]),4)'),
  metric('cap_daily_pct', 'ATTENDANCE_DAILY capacity used', 'CAPACITY', 'ROUND(COUNTA([ATTENDANCE_DAILY.attendance_id])/ROWS([ATTENDANCE_DAILY.attendance_id]),4)'),
  metric('cap_payroll_pct', 'PAYROLL_INPUTS capacity used', 'CAPACITY', 'ROUND(COUNTA([PAYROLL_INPUTS.input_id])/ROWS([PAYROLL_INPUTS.input_id]),4)'),
];

export const SYSTEM_TABS: TabDef[] = [
  {
    name: 'NOTIFICATIONS', group: 'System', protection: 'SERVICE_ONLY', capacity: 20000, keyColumn: 'notification_id',
    purpose: 'Notification outbox (email / SMS / WhatsApp / in-app). Adapters drain QUEUED rows.',
    columns: [
      id('notification_id'), inp('recipient_employee_id'), en('channel', 'NOTIF_CHANNEL'), inp('template'), inp('subject'), inp('payload_json', 'json'),
      inp('send_after', 'datetime'), inp('attempts', 'number'), inp('last_error'), inp('sent_at', 'datetime'), inp('read_at', 'datetime'), ...aud('NOTIF_STATUS'),
    ],
  },
  {
    name: 'AUDIT_LOG', group: 'System', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 100000, keyColumn: 'audit_id',
    purpose: 'Immutable audit trail: who, what, when, source, before, after, reason, request id. entry_hash chains each row to the previous one for tamper evidence.',
    columns: [
      id('audit_id'), inp('timestamp', 'datetime'), inp('actor_user_id'), inp('actor_role'), inp('action', 'text', { required: true }), inp('entity_type'), inp('entity_id'),
      inp('before_json', 'json'), inp('after_json', 'json'), inp('reason'), inp('source'), inp('request_id'), inp('ip_address'), inp('prev_hash'), inp('entry_hash'),
    ],
  },
  {
    name: 'ERROR_LOG', group: 'System', protection: 'SERVICE_ONLY', appendOnly: true, capacity: 20000, keyColumn: 'error_id',
    purpose: 'Application and system errors (no secrets, no biometric data, no full payloads).',
    columns: [
      id('error_id'), inp('timestamp', 'datetime'), en('severity', 'SEVERITY'), inp('module'), inp('message'), inp('stack_hash'), inp('context_json', 'json'), inp('request_id'), inp('user_id'),
    ],
  },
  {
    name: 'DASHBOARD_DATA', group: 'Reporting', protection: 'SERVICE_ONLY', capacity: 100, keyColumn: 'metric_key',
    purpose: 'Pre-shaped dashboard metrics, formula health checks and capacity monitors. Every value is a formula.',
    columns: [id('metric_key'), inp('label'), inp('group'), fx('value', '', 'text')],
    fixedRows: DASHBOARD_ROWS,
  },
  {
    name: 'README', group: 'System', protection: 'SERVICE_ONLY', capacity: 100, keyColumn: 'tab',
    purpose: 'Human readable description of every tab and how it is protected.',
    columns: [inp('tab'), inp('group'), inp('purpose'), inp('append_only'), inp('protection'), inp('input_columns'), inp('formula_columns'), inp('capacity_rows')],
  },
];

export { aud };
