import type { Resource } from '@nutex/types';

/**
 * Reports are selections / projections over Sheet-calculated columns. The engine filters, sorts, paginates and
 * (for cost reports) sums figures that the sheet formulas already computed. It never re-derives attendance / leave / payroll values.
 */
export type Cell = string | number | null;
export type ReportRow = Record<string, Cell>;

export interface ColumnSpec { key: string; label: string; type?: 'text' | 'number' | 'money' | 'date'; sum?: boolean }
export interface ParamSpec { name: string; label: string; type: 'date' | 'text' | 'period' | 'select'; required?: boolean; options?: string[] }

export interface ReportDef {
  id: string;
  title: string;
  description: string;
  /** which loader supplies the rows (resolved by the API) */
  source: 'ATTENDANCE_DAILY' | 'ATTENDANCE_EVENTS' | 'LEAVE_BALANCES' | 'LEAVE_APPLICATIONS' | 'OVERTIME' | 'PAYROLL_INPUTS' | 'PAYROLL' | 'STATUTORY_CALC' | 'EMPLOYEE_SALARY' | 'REIMBURSEMENTS' | 'LOANS' | 'FULL_FINAL';
  resource: Resource;
  params: ParamSpec[];
  columns: ColumnSpec[];
  where?: (row: ReportRow, p: Record<string, string>) => boolean;
  sort?: string[];
  groupBy?: { key: string; label: string };
}

const inRange = (col: string) => (r: ReportRow, p: Record<string, string>) => {
  const v = String(r[col] ?? '');
  return (!p.from || v >= p.from) && (!p.to || v <= p.to);
};
const num = (v: Cell) => Number(v ?? 0);
const emp: ColumnSpec[] = [{ key: 'employee_code', label: 'Code' }, { key: 'employee_name', label: 'Employee' }, { key: 'department_id', label: 'Dept' }];
const dateParams: ParamSpec[] = [{ name: 'from', label: 'From', type: 'date', required: true }, { name: 'to', label: 'To', type: 'date', required: true }];
const period: ParamSpec[] = [{ name: 'period', label: 'Payroll period', type: 'period', required: true }];
const attCols: ColumnSpec[] = [...emp, { key: 'work_date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status' }, { key: 'first_in', label: 'In' }, { key: 'last_out', label: 'Out' }, { key: 'worked_minutes', label: 'Worked (min)', type: 'number', sum: true }, { key: 'late_minutes', label: 'Late (min)', type: 'number', sum: true }, { key: 'early_minutes', label: 'Early (min)', type: 'number', sum: true }];
const pay = (extra: ColumnSpec[]): ColumnSpec[] => [...emp, ...extra];

export const REPORTS: ReportDef[] = [
  { id: 'daily_attendance', title: 'Daily attendance', description: 'Formula-derived attendance for one day', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: [{ name: 'from', label: 'Date', type: 'date', required: true }], columns: attCols, where: (r, p) => r.work_date === p.from && r.status !== 'NA', sort: ['employee_code'] },
  { id: 'monthly_attendance', title: 'Monthly attendance', description: 'Every day in the range, per employee', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: dateParams, columns: attCols, where: (r, p) => inRange('work_date')(r, p) && r.status !== 'NA', sort: ['employee_code', 'work_date'] },
  { id: 'late', title: 'Late arrivals', description: 'Days with late minutes beyond grace', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: dateParams, columns: attCols, where: (r, p) => inRange('work_date')(r, p) && num(r.late_minutes) > 0, sort: ['work_date', 'employee_code'] },
  { id: 'early', title: 'Early exits', description: 'Days with early leaving beyond grace', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: dateParams, columns: attCols, where: (r, p) => inRange('work_date')(r, p) && num(r.early_minutes) > 0, sort: ['work_date', 'employee_code'] },
  { id: 'missing_punch', title: 'Missing punch', description: 'Unresolved missing punches', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: dateParams, columns: attCols, where: (r, p) => inRange('work_date')(r, p) && r.exception_flag === 'MISSING_PUNCH', sort: ['work_date', 'employee_code'] },
  { id: 'absent', title: 'Absent', description: 'Days marked ABSENT by the attendance formulas', source: 'ATTENDANCE_DAILY', resource: 'attendance', params: dateParams, columns: attCols, where: (r, p) => inRange('work_date')(r, p) && r.status === 'ABSENT', sort: ['work_date', 'employee_code'] },
  { id: 'attendance_locations', title: 'Check-in / check-out locations', description: 'Every punch with the coordinates the device reported, the distance from the branch and a map link', source: 'ATTENDANCE_EVENTS', resource: 'attendance_events', params: dateParams,
    columns: [...emp, { key: 'event_datetime', label: 'Time' }, { key: 'event_type', label: 'Type' }, { key: 'geo_lat', label: 'Latitude', type: 'number' }, { key: 'geo_lng', label: 'Longitude', type: 'number' }, { key: 'geo_accuracy', label: 'Accuracy (m)', type: 'number' }, { key: 'geo_distance_m', label: 'From branch (m)', type: 'number' }, { key: 'geo_status', label: 'Geofence' }, { key: 'capture_method', label: 'Via' }, { key: 'map_url', label: 'Map' }],
    where: (r, p) => { const d = String(r.event_datetime ?? '').slice(0, 10); return (!p.from || d >= p.from) && (!p.to || d <= p.to); }, sort: ['event_datetime', 'employee_code'] },
  { id: 'attendance_summary', title: 'Attendance summary (payroll basis)', description: 'Paid days, LOP and OT per employee for a payroll period', source: 'PAYROLL_INPUTS', resource: 'attendance', params: period,
    columns: pay([{ key: 'window_days', label: 'Days in service', type: 'number' }, { key: 'paid_days', label: 'Paid days', type: 'number', sum: true }, { key: 'lop_days', label: 'LOP days', type: 'number', sum: true }, { key: 'ot_reg_min', label: 'OT regular (min)', type: 'number', sum: true }, { key: 'ot_off_min', label: 'OT off-day (min)', type: 'number', sum: true }]),
    where: (r, p) => r.period_id === p.period, sort: ['employee_code'] },
  { id: 'lop', title: 'Loss of pay', description: 'Employees with LOP days in the period', source: 'PAYROLL_INPUTS', resource: 'attendance', params: period, columns: pay([{ key: 'lop_days', label: 'LOP days', type: 'number', sum: true }, { key: 'paid_days', label: 'Paid days', type: 'number' }]), where: (r, p) => r.period_id === p.period && num(r.lop_days) > 0, sort: ['employee_code'] },
  { id: 'leave_balance', title: 'Leave balance', description: 'Ledger balance per employee and type', source: 'LEAVE_BALANCES', resource: 'leave_balances', params: [{ name: 'year', label: 'Leave year', type: 'text' }],
    columns: pay([{ key: 'leave_type_id', label: 'Type' }, { key: 'leave_year', label: 'Year' }, { key: 'credited', label: 'Credited', type: 'number' }, { key: 'debited', label: 'Debited', type: 'number' }, { key: 'balance', label: 'Balance', type: 'number' }, { key: 'pending_approval', label: 'Pending', type: 'number' }, { key: 'available', label: 'Available', type: 'number' }]),
    where: (r, p) => !p.year || String(r.leave_year) === p.year, sort: ['employee_code', 'leave_type_id'] },
  { id: 'leave_utilization', title: 'Leave utilisation', description: 'Approved leave in a date range', source: 'LEAVE_APPLICATIONS', resource: 'leave', params: dateParams,
    columns: pay([{ key: 'leave_type_id', label: 'Type' }, { key: 'from_date', label: 'From', type: 'date' }, { key: 'to_date', label: 'To', type: 'date' }, { key: 'days_count', label: 'Days', type: 'number', sum: true }, { key: 'status', label: 'Status' }]),
    where: (r, p) => r.status === 'APPROVED' && String(r.from_date) <= (p.to ?? '9999') && String(r.to_date) >= (p.from ?? '0000'), sort: ['from_date', 'employee_code'] },
  { id: 'overtime', title: 'Overtime', description: 'Approved overtime and payable minutes', source: 'OVERTIME', resource: 'overtime', params: dateParams,
    columns: pay([{ key: 'work_date', label: 'Date', type: 'date' }, { key: 'day_type', label: 'Day type' }, { key: 'approved_minutes', label: 'Approved (min)', type: 'number', sum: true }, { key: 'calc_minutes', label: 'Calculated (min)', type: 'number' }, { key: 'payable_minutes', label: 'Payable (min)', type: 'number', sum: true }, { key: 'status', label: 'Status' }]),
    where: inRange('work_date'), sort: ['work_date', 'employee_code'] },
  { id: 'payroll_register', title: 'Payroll register', description: 'Gross, deductions, net and employer cost (locked periods come from the immutable snapshot)', source: 'PAYROLL', resource: 'payroll', params: period,
    columns: pay([{ key: 'paid_days', label: 'Paid days', type: 'number' }, { key: 'gross_earnings', label: 'Gross', type: 'money', sum: true }, { key: 'total_deductions', label: 'Deductions', type: 'money', sum: true }, { key: 'reimbursement', label: 'Reimb.', type: 'money', sum: true }, { key: 'net_pay', label: 'Net pay', type: 'money', sum: true }, { key: 'employer_cost', label: 'Employer cost', type: 'money', sum: true }]),
    sort: ['employee_code'] },
  { id: 'net_gross', title: 'Net / gross', description: 'Gross vs net per employee', source: 'PAYROLL', resource: 'payroll', params: period, columns: pay([{ key: 'gross_earnings', label: 'Gross', type: 'money', sum: true }, { key: 'net_pay', label: 'Net', type: 'money', sum: true }]), sort: ['employee_code'] },
  { id: 'department_cost', title: 'Department cost', description: 'Employer cost by department (sum of sheet-calculated figures)', source: 'PAYROLL', resource: 'payroll', params: period, groupBy: { key: 'department_id', label: 'Department' },
    columns: [{ key: 'department_id', label: 'Department' }, { key: 'gross_earnings', label: 'Gross', type: 'money', sum: true }, { key: 'net_pay', label: 'Net', type: 'money', sum: true }, { key: 'employer_cost', label: 'Employer cost', type: 'money', sum: true }] },
  { id: 'branch_cost', title: 'Branch cost', description: 'Employer cost by branch', source: 'PAYROLL', resource: 'payroll', params: period, groupBy: { key: 'location_id', label: 'Branch' },
    columns: [{ key: 'location_id', label: 'Branch' }, { key: 'gross_earnings', label: 'Gross', type: 'money', sum: true }, { key: 'net_pay', label: 'Net', type: 'money', sum: true }, { key: 'employer_cost', label: 'Employer cost', type: 'money', sum: true }] },
  { id: 'salary_register', title: 'Salary register', description: 'Effective-dated salary structures', source: 'EMPLOYEE_SALARY', resource: 'salary', params: [],
    columns: pay([{ key: 'effective_from', label: 'From', type: 'date' }, { key: 'basic', label: 'Basic', type: 'money' }, { key: 'hra', label: 'HRA', type: 'money' }, { key: 'da', label: 'DA', type: 'money' }, { key: 'conveyance', label: 'Conv.', type: 'money' }, { key: 'special_allowance', label: 'Special', type: 'money' }, { key: 'monthly_gross', label: 'Monthly gross', type: 'money', sum: true }]), sort: ['employee_code', 'effective_from'] },
  { id: 'reimbursement', title: 'Reimbursements', description: 'Approved reimbursements per period', source: 'REIMBURSEMENTS', resource: 'expenses', params: period, columns: pay([{ key: 'expense_id', label: 'Expense' }, { key: 'amount', label: 'Amount', type: 'money', sum: true }, { key: 'status', label: 'Status' }]), where: (r, p) => r.period_id === p.period, sort: ['employee_code'] },
  { id: 'loan', title: 'Loans', description: 'Loan book with recovered / outstanding', source: 'LOANS', resource: 'loans', params: [], columns: pay([{ key: 'principal', label: 'Principal', type: 'money', sum: true }, { key: 'emi', label: 'EMI', type: 'money' }, { key: 'recovered', label: 'Recovered', type: 'money', sum: true }, { key: 'outstanding', label: 'Outstanding', type: 'money', sum: true }]), where: (r) => r.loan_type === 'LOAN', sort: ['employee_code'] },
  { id: 'advance', title: 'Advances', description: 'Salary advances with recovery status', source: 'LOANS', resource: 'loans', params: [], columns: pay([{ key: 'principal', label: 'Advance', type: 'money', sum: true }, { key: 'recovered', label: 'Recovered', type: 'money', sum: true }, { key: 'outstanding', label: 'Outstanding', type: 'money', sum: true }]), where: (r) => r.loan_type === 'ADVANCE', sort: ['employee_code'] },
  { id: 'statutory', title: 'Statutory', description: 'PF, ESI, PT, LWF and TDS per employee', source: 'STATUTORY_CALC', resource: 'compliance', params: period,
    columns: pay([{ key: 'pf_wage_capped', label: 'PF wage', type: 'money' }, { key: 'pf_emp', label: 'PF (EE)', type: 'money', sum: true }, { key: 'pf_er', label: 'PF (ER)', type: 'money', sum: true }, { key: 'esi_emp', label: 'ESI (EE)', type: 'money', sum: true }, { key: 'esi_er', label: 'ESI (ER)', type: 'money', sum: true }, { key: 'pt', label: 'PT', type: 'money', sum: true }, { key: 'lwf_emp', label: 'LWF (EE)', type: 'money', sum: true }, { key: 'tds', label: 'TDS', type: 'money', sum: true }]),
    sort: ['employee_code'] },
  { id: 'fnf', title: 'Full & final', description: 'Settlement per exited employee', source: 'FULL_FINAL', resource: 'payroll', params: [], columns: pay([{ key: 'last_working_day', label: 'LWD', type: 'date' }, { key: 'total_payable', label: 'Payable', type: 'money', sum: true }, { key: 'total_recoveries', label: 'Recoveries', type: 'money', sum: true }, { key: 'net_full_final', label: 'Net F&F', type: 'money', sum: true }, { key: 'status', label: 'Status' }]), sort: ['employee_code'] },
];

export interface RunOptions { page?: number; pageSize?: number }
export interface ReportResult { id: string; title: string; columns: ColumnSpec[]; rows: ReportRow[]; total: number; page: number; pageSize: number; totals: Record<string, number> }

export function missingParams(def: ReportDef, p: Record<string, string>): string[] {
  return def.params.filter((x) => x.required && !p[x.name]).map((x) => x.name);
}

export function runReport(def: ReportDef, input: ReportRow[], params: Record<string, string>, o: RunOptions = {}): ReportResult {
  let rows = def.where ? input.filter((r) => def.where!(r, params)) : [...input];
  if (def.groupBy) {
    const g = new Map<string, ReportRow>();
    const sums = def.columns.filter((c) => c.sum).map((c) => c.key);
    for (const r of rows) {
      const k = String(r[def.groupBy.key] ?? '(none)');
      const acc = g.get(k) ?? { [def.groupBy.key]: k, ...Object.fromEntries(sums.map((s) => [s, 0])) };
      for (const s of sums) acc[s] = Math.round((num(acc[s]) + num(r[s])) * 100) / 100;
      g.set(k, acc);
    }
    rows = [...g.values()].sort((a, b) => String(a[def.groupBy!.key]).localeCompare(String(b[def.groupBy!.key])));
  } else if (def.sort?.length) {
    rows = [...rows].sort((a, b) => {
      for (const k of def.sort!) {
        const c = String(a[k] ?? '').localeCompare(String(b[k] ?? ''), undefined, { numeric: true });
        if (c) return c;
      }
      return 0;
    });
  }
  const totals: Record<string, number> = {};
  for (const c of def.columns) if (c.sum) totals[c.key] = Math.round(rows.reduce((s, r) => s + num(r[c.key]), 0) * 100) / 100;
  const pageSize = Math.min(Math.max(o.pageSize ?? 50, 1), 1000);
  const page = Math.max(o.page ?? 1, 1);
  return { id: def.id, title: def.title, columns: def.columns, rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, totals };
}

function csvCell(v: Cell): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ColumnSpec[], rows: ReportRow[]): string {
  return [columns.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c.key] ?? null)).join(','))].join('\n');
}
