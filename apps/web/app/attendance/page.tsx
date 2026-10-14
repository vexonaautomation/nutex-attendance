'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { PunchLog } from '@/components/PunchLog';
import { RequestDialog } from '@/components/WorkflowPage';
import { Badge, Card, ConfirmDialog, ErrorState, PageHeader, Tabs } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';
import { dateOnly, isoDay, minutesToHm, monthRange, timeOnly } from '@/lib/format';

type Row = Record<string, unknown>;
const cols = (withEmp: boolean) => [
  ...(withEmp ? [{ key: 'employee_id', label: 'Employee' }] : []),
  { key: 'work_date', label: 'Date' }, { key: 'status', label: 'Status', render: (r: Row) => <Badge value={r.status} /> },
  { key: 'first_in', label: 'In', render: (r: Row) => timeOnly(r.first_in), value: (r: Row) => timeOnly(r.first_in) }, { key: 'last_out', label: 'Out', render: (r: Row) => timeOnly(r.last_out), value: (r: Row) => timeOnly(r.last_out) },
  { key: 'worked_minutes', label: 'Worked', render: (r: Row) => minutesToHm(r.worked_minutes), align: 'num' as const, value: (r: Row) => Number(r.worked_minutes ?? 0) },
  { key: 'late_minutes', label: 'Late (m)', align: 'num' as const }, { key: 'early_minutes', label: 'Early (m)', align: 'num' as const }, { key: 'day_credit', label: 'Credit', align: 'num' as const },
  { key: 'exception_flag', label: 'Flag', render: (r: Row) => (r.exception_flag ? <Badge value={r.exception_flag} tone="bad" /> : <span className="muted">-</span>) },
];

export default function AttendancePage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState('mine');
  const [ym, setYm] = useState(isoDay().slice(0, 7));
  const [team, setTeam] = useState({ from: monthRange(isoDay().slice(0, 7)).from, to: isoDay() });
  const [regFor, setRegFor] = useState<Row | null>(null);
  const [waive, setWaive] = useState<Row | null>(null);
  const [manual, setManual] = useState(false);
  const [punchTick, setPunchTick] = useState(0);
  const r = monthRange(ym);
  const mine = useFetch<Row[]>(tab === 'mine' ? `/api/attendance/me?from=${r.from}&to=${r.to}` : null);
  const all = useFetch<Row[]>(tab === 'team' ? `/api/attendance/daily?from=${team.from}&to=${team.to}` : null);
  const adj = useFetch<Row[]>(tab === 'adjust' ? '/api/attendance/adjustments' : null);
  const exc = useFetch<Row[]>(tab === 'exceptions' ? '/api/attendance/exceptions' : null);
  const [decide, setDecide] = useState<{ row: Row; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const { busy, run } = useAction();

  const tabs = [
    { id: 'mine', label: 'My attendance' },
    ...(me?.role !== 'EMPLOYEE' ? [{ id: 'team', label: 'Team / branch' }] : []),
    { id: 'adjust', label: 'Regularisations' },
    ...(can('attendance', 'approve') ? [{ id: 'exceptions', label: 'Exceptions' }] : []),
    ...(can('attendance_events') ? [{ id: 'locations', label: 'Check-in locations' }] : []),
  ];

  return (
    <>
      <PageHeader title="Attendance" subtitle="Derived by the sheet formulas from location-verified check-ins, roster, holidays, leave and approved corrections." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'mine' && (
        <Card title="My month" actions={<input type="month" aria-label="Month" value={ym} onChange={(e) => setYm(e.target.value)} style={{ width: 170 }} />}>
          {mine.error ? <ErrorState error={mine.error} onRetry={mine.reload} /> : (
            <DataTable<Row> columns={[...cols(false), { key: '_a', label: '', sortable: false, render: (x) => ['ABSENT', 'HALF_DAY', 'MISSING_PUNCH'].includes(String(x.status)) && x.is_period_locked !== 1 ? <button className="btn sm" onClick={() => setRegFor(x)}>Regularise</button> : null }]}
              rows={mine.data} loading={mine.loading} pageSize={31} exportName={`my-attendance-${ym}`} />
          )}
        </Card>
      )}
      {tab === 'team' && (
        <Card title="Team / branch attendance" actions={<span className="row"><input type="date" aria-label="From" value={team.from} onChange={(e) => setTeam({ ...team, from: e.target.value })} style={{ width: 160 }} /><input type="date" aria-label="To" value={team.to} onChange={(e) => setTeam({ ...team, to: e.target.value })} style={{ width: 160 }} /></span>}>
          {all.error ? <ErrorState error={all.error} onRetry={all.reload} /> : <DataTable<Row> columns={cols(true)} rows={all.data} loading={all.loading} exportName="team-attendance" />}
        </Card>
      )}
      {tab === 'locations' && (
        <Card title="Check-in / check-out locations"
          actions={<span className="row">
            <input type="date" aria-label="From" value={team.from} onChange={(e) => setTeam({ ...team, from: e.target.value })} style={{ width: 160 }} />
            <input type="date" aria-label="To" value={team.to} onChange={(e) => setTeam({ ...team, to: e.target.value })} style={{ width: 160 }} />
            {can('attendance', 'approve') && <button className="btn" onClick={() => setManual(true)}>Add manual punch</button>}
          </span>}>
          <p className="muted" style={{ marginBottom: 10 }}>The coordinates reported by the phone or computer at each check-in and check-out. The same values are stored in the workbook (ATTENDANCE_EVENTS: geo_lat, geo_lng, geo_accuracy, map_url).</p>
          <PunchLog key={`${team.from}-${team.to}-${punchTick}`} from={team.from} to={team.to} showEmployee={me?.role !== 'EMPLOYEE'} exportName="punch-locations" />
        </Card>
      )}
      {manual && (
        <RequestDialog title="Add manual punch" url="/api/attendance/manual-punch"
          fields={[{ name: 'employeeId', label: 'Employee id', type: 'text', required: true }, { name: 'type', label: 'Type', type: 'select', options: ['IN', 'OUT'], required: true, default: 'IN' },
            { name: 'at', label: 'Date and time', type: 'datetime-local', required: true, default: `${isoDay()}T09:00` }, { name: 'reason', label: 'Reason (audited)', type: 'textarea', required: true, hint: 'For example: phone lost, no signal at the site' }]}
          build={(v) => ({ employeeId: v.employeeId, type: v.type, at: `${v.at}:00`, reason: v.reason })}
          onClose={() => setManual(false)} onDone={() => setPunchTick((n) => n + 1)} />
      )}
      {tab === 'adjust' && (
        <Card title="Regularisation requests">
          {adj.error ? <ErrorState error={adj.error} onRetry={adj.reload} /> : (
            <DataTable<Row> rows={adj.data} loading={adj.loading} exportName="regularisations"
              columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'work_date', label: 'Date' }, { key: 'adjustment_type', label: 'Type' }, { key: 'adjusted_in', label: 'In', render: (x) => timeOnly(x.adjusted_in) }, { key: 'adjusted_out', label: 'Out', render: (x) => timeOnly(x.adjusted_out) },
                { key: 'reason', label: 'Reason' }, { key: 'status', label: 'Status', render: (x) => <Badge value={x.status} /> },
                { key: '_a', label: '', sortable: false, render: (x) => x.status === 'PENDING' && can('adjustments', 'approve') && x.employee_id !== me?.employeeId ? (
                  <span className="row" style={{ gap: 6 }}><button className="btn sm primary" onClick={() => setDecide({ row: x, decision: 'APPROVED' })}>Approve</button><button className="btn sm danger" onClick={() => setDecide({ row: x, decision: 'REJECTED' })}>Reject</button></span>) : null }]} />
          )}
        </Card>
      )}
      {tab === 'exceptions' && (
        <Card title="Attendance exceptions" actions={can('attendance', 'write') && <button className="btn" disabled={busy} onClick={async () => { await run(() => api.post('/api/attendance/exceptions/sync'), 'Exceptions synced'); exc.reload(); }}>Sync from attendance</button>}>
          {exc.error ? <ErrorState error={exc.error} onRetry={exc.reload} /> : (
            <DataTable<Row> rows={exc.data} loading={exc.loading} exportName="exceptions"
              columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'work_date', label: 'Date', render: (x) => dateOnly(x.work_date) }, { key: 'exception_type', label: 'Type' }, { key: 'status', label: 'Status', render: (x) => <Badge value={x.status} /> }, { key: 'resolution_note', label: 'Note' },
                { key: '_a', label: '', sortable: false, render: (x) => x.status === 'OPEN' ? <button className="btn sm" onClick={() => setWaive(x)}>Waive</button> : null }]} />
          )}
        </Card>
      )}
      {regFor && (
        <RequestDialog title={`Regularise ${dateOnly(regFor.work_date)}`} url="/api/attendance/adjustments"
          fields={[{ name: 'type', label: 'Type', type: 'select', options: ['MISSING_PUNCH', 'TIME_CORRECTION'], required: true, default: 'TIME_CORRECTION' }, { name: 'adjustedIn', label: 'Correct in time', type: 'datetime-local', default: `${dateOnly(regFor.work_date)}T09:00` }, { name: 'adjustedOut', label: 'Correct out time', type: 'datetime-local', default: `${dateOnly(regFor.work_date)}T18:00` }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          build={(v) => ({ workDate: dateOnly(regFor.work_date), type: v.type, ...(v.adjustedIn ? { adjustedIn: `${v.adjustedIn}:00` } : {}), ...(v.adjustedOut ? { adjustedOut: `${v.adjustedOut}:00` } : {}), reason: v.reason })}
          onClose={() => setRegFor(null)} onDone={() => { mine.reload(); adj.reload(); }} />
      )}
      {decide && (
        <ConfirmDialog title={`${decide.decision === 'APPROVED' ? 'Approve' : 'Reject'} regularisation`} danger={decide.decision === 'REJECTED'} confirmLabel={decide.decision === 'APPROVED' ? 'Approve' : 'Reject'} withReason={decide.decision === 'REJECTED'} message="The original punches are never changed; an approved correction only supplies the effective in / out time."
          onClose={() => setDecide(null)} onConfirm={async (note) => { await api.post(`/api/attendance/adjustments/${String(decide.row.adjustment_id)}/decision`, { decision: decide.decision, ...(note ? { note } : {}) }); adj.reload(); }} />
      )}
      {waive && <ConfirmDialog title="Waive exception" withReason confirmLabel="Waive" message="Waived exceptions stop blocking payroll. The reason is audited." onClose={() => setWaive(null)} onConfirm={async (note) => { await api.post(`/api/attendance/exceptions/${String(waive.exception_id)}/waive`, { note }); exc.reload(); }} />}
    </>
  );
}
