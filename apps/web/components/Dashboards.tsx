'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { useFetch } from '@/hooks/useApi';
import { inr, isoDay, minutesToHm, monthRange } from '@/lib/format';
import { CountUp } from './Fx';
import { PunchCard } from './PunchCard';
import { PunchLog } from './PunchLog';
import { currentStructure, type SalaryRow } from './SalaryPanel';
import { Badge, Card, ErrorState, Loading } from './ui';
import { Icon } from './Icon';

type Row = Record<string, unknown>;

const PRESENT = new Set(['PRESENT', 'WFH_OD', 'HOLIDAY_WORK', 'WEEKOFF_WORK']);

/** what a normal employee sees: check in / out, their month, their leave, their pay */
export function EmployeeDashboard() {
  const today = isoDay();
  const { from } = monthRange(today.slice(0, 7));
  const days = useFetch<Row[]>(`/api/attendance/me?from=${from}&to=${today}`);
  const leave = useFetch<Row[]>('/api/leave/balances');
  const slips = useFetch<Row[]>('/api/payslips');
  const salary = useFetch<SalaryRow[]>('/api/r/salaries');

  const month = useMemo(() => {
    const rows = (days.data ?? []).filter((r) => String(r.work_date) <= today);
    const past = rows.filter((r) => String(r.work_date) < today);
    return {
      present: rows.filter((r) => PRESENT.has(String(r.status))).length,
      half: rows.filter((r) => r.status === 'HALF_DAY').length,
      leave: rows.filter((r) => r.status === 'LEAVE' || r.status === 'UNPAID_LEAVE').length,
      absent: past.filter((r) => r.status === 'ABSENT').length,
      late: rows.filter((r) => Number(r.late_minutes ?? 0) > 0).length,
      worked: rows.reduce((n, r) => n + Number(r.worked_minutes ?? 0), 0),
      missing: rows.filter((r) => r.status === 'MISSING_PUNCH').length,
    };
  }, [days.data, today]);

  const latest = [...(slips.data ?? [])].sort((a, b) => String(b.periodId).localeCompare(String(a.periodId)))[0];
  const cur = currentStructure(salary.data ?? []);
  const balances = (leave.data ?? []).filter((b) => Number(b.available ?? b.balance ?? 0) !== 0 || Number(b.credited ?? 0) > 0).slice(0, 6);

  return (
    <>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <PunchCard />
        <Card title="This month">
          {days.error ? <ErrorState error={days.error} onRetry={days.reload} /> : days.loading && !days.data ? <Loading rows={3} /> : (
            <div className="grid cols-3">
              <div className="kpi"><span className="v"><CountUp value={month.present} /></span><span className="l">days present</span></div>
              <div className="kpi"><span className="v"><CountUp value={month.half} /></span><span className="l">half days</span></div>
              <div className="kpi"><span className="v"><CountUp value={month.leave} /></span><span className="l">on leave</span></div>
              <div className="kpi"><span className="v"><CountUp value={month.absent} /></span><span className="l">absent</span></div>
              <div className="kpi"><span className="v"><CountUp value={month.late} /></span><span className="l">late arrivals</span></div>
              <div className="kpi"><span className="v">{minutesToHm(month.worked) === '-' ? '0h' : minutesToHm(month.worked)}</span><span className="l">hours worked</span></div>
            </div>
          )}
          {month.missing > 0 && <div className="notice warn" style={{ marginTop: 12 }}>{month.missing} day{month.missing > 1 ? 's have' : ' has'} a missing punch. <Link href="/attendance">Regularise</Link> so it counts for payroll.</div>}
        </Card>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title="My pay" actions={<Link href="/payslips" className="btn sm">Payslips</Link>}>
          <div className="grid cols-2">
            <div className="kpi"><span className="v">{cur ? inr(cur.monthly_gross) : '-'}</span><span className="l">monthly gross salary{cur ? `, from ${String(cur.effective_from).slice(0, 10)}` : ' (not set yet)'}</span></div>
            <div className="kpi"><span className="v">{latest ? inr(latest.netPay) : '-'}</span><span className="l">{latest ? `net pay, ${String(latest.periodId)}` : 'no payslip yet'}</span></div>
          </div>
        </Card>
        <Card title="My leave" actions={<Link href="/leave" className="btn sm">Apply for leave</Link>}>
          {leave.loading && !leave.data ? <Loading rows={2} /> : balances.length === 0 ? <p className="muted">No leave balance yet.</p> : (
            <div className="grid cols-3">
              {balances.map((b) => <div className="kpi" key={String(b.balance_id ?? b.leave_type_id)}><span className="v">{String(b.available ?? b.balance ?? 0)}</span><span className="l">{String(b.leave_type_id).replace('LT-', '')} available</span></div>)}
            </div>
          )}
        </Card>
      </div>

      <Card title="My recent check-ins">
        <PunchLog from={new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)} to={today} showEmployee={false} exportName="my-check-ins" />
      </Card>
    </>
  );
}

function Alert({ ok, children, href, action }: { ok: boolean; children: React.ReactNode; href: string; action: string }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <Badge value={ok ? 'Done' : 'To do'} tone={ok ? 'ok' : 'warn'} />
      <span>{children}</span>
      <span className="spacer" />
      {!ok && <Link href={href} className="btn sm">{action}</Link>}
    </div>
  );
}

/** owner / admin: what to set up, who is where right now, and the shortcuts for daily work */
export function AdminDashboard() {
  const today = isoDay();
  const emps = useFetch<Row[]>('/api/r/employees');
  const users = useFetch<Row[]>('/api/users');
  const sal = useFetch<SalaryRow[]>('/api/r/salaries');
  const locs = useFetch<Row[]>('/api/r/locations');

  const check = useMemo(() => {
    if (!emps.data || !users.data || !sal.data || !locs.data) return undefined;
    const active = emps.data.filter((e) => e.status !== 'INACTIVE');
    const withLogin = new Set(users.data.filter((u) => u.status !== 'DISABLED').map((u) => String(u.employeeId)));
    const withSalary = new Set(sal.data.map((s) => String(s.employee_id)));
    return {
      noCoords: locs.data.filter((l) => l.status !== 'INACTIVE' && (l.latitude == null || l.longitude == null || l.latitude === '')).length,
      noLogin: active.filter((e) => !withLogin.has(String(e.employee_id))).length,
      noSalary: active.filter((e) => !withSalary.has(String(e.employee_id))).length,
      people: active.length,
    };
  }, [emps.data, users.data, sal.data, locs.data]);

  return (
    <>
      <Card title="Quick actions">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn primary" href="/employees"><Icon name="plus" size={16} /> Add employee</Link>
          <Link className="btn" href="/settings?tab=users"><Icon name="key" size={16} /> Create login</Link>
          <Link className="btn" href="/settings?tab=org"><Icon name="pin" size={16} /> Branch locations</Link>
          <Link className="btn" href="/attendance">Attendance today</Link>
          <Link className="btn" href="/payroll">Payroll</Link>
          <Link className="btn" href="/reports">Reports</Link>
        </div>
      </Card>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <PunchCard />
        <Card title="Setup checklist">
          {!check ? <Loading rows={3} /> : (
            <div className="stack" style={{ gap: 10 }}>
              <Alert ok={check.noCoords === 0} href="/settings?tab=org" action="Set coordinates">{check.noCoords === 0 ? 'Every branch has its coordinates' : `${check.noCoords} branch${check.noCoords > 1 ? 'es have' : ' has'} no coordinates (check-in distance cannot be measured)`}</Alert>
              <Alert ok={check.noLogin === 0} href="/settings?tab=users" action="Create logins">{check.noLogin === 0 ? 'Every employee has a login' : `${check.noLogin} employee${check.noLogin > 1 ? 's have' : ' has'} no login yet, so they cannot check in`}</Alert>
              <Alert ok={check.noSalary === 0} href="/employees" action="Open employees">{check.noSalary === 0 ? 'Every employee has a salary structure' : `${check.noSalary} employee${check.noSalary > 1 ? 's have' : ' has'} no salary yet (Employees, open a profile, Salary tab)`}</Alert>
              <p className="muted" style={{ fontSize: '0.85rem' }}>{check.people} active employee{check.people === 1 ? '' : 's'}.</p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Check-ins today" actions={<Link href="/attendance" className="btn sm">All locations</Link>}>
        <PunchLog from={today} to={today} exportName={`check-ins-${today}`} />
      </Card>
    </>
  );
}
