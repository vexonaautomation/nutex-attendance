'use client';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { AdminDashboard, EmployeeDashboard } from '@/components/Dashboards';
import { CountUp } from '@/components/Fx';
import { PunchCard } from '@/components/PunchCard';
import { Badge, Card, ErrorState, Loading, PageHeader } from '@/components/ui';
import { useFetch } from '@/hooks/useApi';
import { inr, label, num } from '@/lib/format';

interface Metric { label: string; group: string; value: number | string | null }
const MONEY = new Set(['payroll_gross', 'payroll_net', 'payroll_employer_cost']);
const GROUP_TITLES: Record<string, string> = { HEADCOUNT: 'People', ATTENDANCE: 'Attendance today', APPROVALS: 'Waiting for approval', PAYROLL: 'Payroll', HEALTH: 'Workbook health', CAPACITY: 'Capacity' };

const VIEW: Record<string, { title: string; subtitle: string }> = {
  SUPER_ADMIN: { title: 'Owner / Admin', subtitle: 'The whole company: set up people, logins and salaries, watch today\'s check-ins, run payroll.' },
  HR_ADMIN: { title: 'HR', subtitle: 'Your branch: people, attendance, leave and approvals.' },
  MANAGER: { title: 'Manager', subtitle: 'Your team today, and your own attendance.' },
  FINANCE_PAYROLL: { title: 'Finance', subtitle: 'Payroll, salary and statutory figures.' },
  ATTENDANCE_OPERATOR: { title: 'Site clerk', subtitle: 'Attendance of your branch.' },
  EMPLOYEE: { title: 'My dashboard', subtitle: 'Check in and out, see your month, leave and pay.' },
};

/** KPI blocks calculated by the workbook formulas (DASHBOARD_DATA), filtered by what the role may see */
function Kpis() {
  const { can } = useAuth();
  const dash = useFetch<{ companyWide: boolean; metrics: Record<string, Metric> }>('/api/dashboard');
  const inbox = useFetch<unknown[]>(can('approvals') || can('leave', 'approve') ? '/api/approvals' : null);
  const notes = useFetch<Array<{ id: string; subject: string; at: string }>>('/api/notifications');

  const groups = new Map<string, Array<[string, Metric]>>();
  for (const [k, m] of Object.entries(dash.data?.metrics ?? {})) {
    if (k.startsWith('h_errors_')) continue; // per-tab error counters roll up into one figure below
    groups.set(m.group, [...(groups.get(m.group) ?? []), [k, m]]);
  }
  const errors = Object.entries(dash.data?.metrics ?? {}).filter(([k]) => k.startsWith('h_errors_')).reduce((n, [, m]) => n + Number(m.value ?? 0), 0);

  return (
    <>
      <Card title="Your inbox" actions={<Link href="/approvals" className="btn sm">Open approvals</Link>}>
        {inbox.loading && !inbox.data ? <Loading rows={2} /> : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="kpi"><span className="v">{inbox.data?.length ?? 0}</span><span className="l">items waiting for your decision</span></div>
            {(notes.data ?? []).slice(0, 4).map((n) => <div key={n.id} className="row"><span>{n.subject}</span><span className="spacer" /><span className="muted mono">{String(n.at ?? '').slice(0, 10)}</span></div>)}
          </div>
        )}
      </Card>
      {dash.error ? <ErrorState error={dash.error} onRetry={dash.reload} /> : dash.loading && !dash.data ? <Loading rows={5} /> : (
        [...groups.entries()].map(([g, items]) => (
          <Card key={g} title={GROUP_TITLES[g] ?? g}>
            <div className="grid cols-4">
              {items.map(([k, m]) => (
                <div className="kpi" key={k}>
                  <span className="v">{typeof m.value === 'string' && m.group === 'PAYROLL' && !MONEY.has(k) ? <Badge value={m.value} /> : MONEY.has(k) ? <CountUp value={Number(m.value ?? 0)} format={(n) => inr(n)} /> : typeof m.value === 'number' ? (m.group === 'CAPACITY' ? <CountUp value={m.value * 100} format={(n) => `${Math.round(n)}%`} /> : <CountUp value={m.value} format={(n) => num(n, 0)} />) : String(m.value ?? '-')}</span>
                  <span className="l">{m.label}</span>
                </div>
              ))}
            </div>
            {g === 'HEALTH' && <p className="muted" style={{ marginTop: 10 }}>Formula errors across calculation tabs: <b>{errors}</b></p>}
          </Card>
        ))
      )}
    </>
  );
}

export default function DashboardPage() {
  const { me, can } = useAuth();
  const role = me?.role ?? 'EMPLOYEE';
  const v = VIEW[role] ?? { title: label(role), subtitle: '' };
  return (
    <>
      <PageHeader title={`${v.title}: welcome, ${me?.name?.split(' ')[0] ?? ''}`} subtitle={v.subtitle} />
      {role === 'EMPLOYEE' ? <EmployeeDashboard /> : role === 'SUPER_ADMIN' ? <><AdminDashboard /><Kpis /></> : (
        <>
          {can('attendance', 'write') && <PunchCard />}
          {can('users', 'write') && (
            <Card title="Quick actions">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Link className="btn primary" href="/employees">Add employee</Link>
                <Link className="btn" href="/settings?tab=users">Logins and passwords</Link>
                <Link className="btn" href="/attendance">Attendance today</Link>
              </div>
            </Card>
          )}
          <Kpis />
        </>
      )}
    </>
  );
}
