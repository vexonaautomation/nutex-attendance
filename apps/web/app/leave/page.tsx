'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { RequestDialog } from '@/components/WorkflowPage';
import { Badge, Card, ConfirmDialog, ErrorState, PageHeader, Tabs } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';
import { Icon } from '@/components/Icon';

type Row = Record<string, unknown>;

export default function LeavePage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState('mine');
  const types = useFetch<Row[]>('/api/leave/types');
  const balances = useFetch<Row[]>('/api/leave/balances');
  const mine = useFetch<Row[]>(tab === 'mine' ? '/api/leave/applications?mine=true' : null);
  const team = useFetch<Row[]>(tab === 'team' ? '/api/leave/applications' : null);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [decide, setDecide] = useState<{ row: Row; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const { busy, run } = useAction();
  const typeName = useMemo(() => new Map((types.data ?? []).map((t) => [String(t.leave_type_id), String(t.name)])), [types.data]);
  const canApprove = can('leave', 'approve');

  const appCols = (withEmp: boolean) => [
    ...(withEmp ? [{ key: 'employee_id', label: 'Employee' }] : []),
    { key: 'leave_type_id', label: 'Type', render: (r: Row) => typeName.get(String(r.leave_type_id)) ?? String(r.leave_type_id) },
    { key: 'from_date', label: 'From' }, { key: 'to_date', label: 'To' }, { key: 'days_count', label: 'Days', align: 'num' as const }, { key: 'reason', label: 'Reason' },
    { key: 'balance_check', label: 'Balance', render: (r: Row) => (r.balance_check && r.balance_check !== 'N/A' ? <Badge value={r.balance_check} tone={r.balance_check === 'OK' ? 'ok' : 'warn'} /> : <span className="muted">-</span>) },
    { key: 'status', label: 'Status', render: (r: Row) => <Badge value={r.status} /> },
    { key: '_a', label: '', sortable: false, render: (r: Row) => (
      <span className="row" style={{ gap: 6 }}>
        {r.status === 'PENDING' && withEmp && canApprove && r.employee_id !== me?.employeeId && (<><button className="btn sm primary" onClick={() => setDecide({ row: r, decision: 'APPROVED' })}>Approve</button><button className="btn sm danger" onClick={() => setDecide({ row: r, decision: 'REJECTED' })}>Reject</button></>)}
        {['PENDING', 'APPROVED'].includes(String(r.status)) && r.employee_id === me?.employeeId && r.is_period_locked !== 1 && <button className="btn sm" onClick={() => setCancelling(r)}>Cancel</button>}
      </span>) },
  ];

  return (
    <>
      <PageHeader title="Leave" subtitle="Balances move only through the auditable leave ledger." actions={can('leave', 'write') && <button className="btn primary" onClick={() => setApplying(true)}><Icon name="plus" size={16} /> Apply</button>} />
      <Card title="My balances">
        {balances.error ? <ErrorState error={balances.error} onRetry={balances.reload} /> : (
          <div className="grid cols-4">
            {(balances.data ?? []).filter((b) => Number(b.quota) > 0 || Number(b.balance) !== 0 || ['LT-CL', 'LT-SL', 'LT-EL'].includes(String(b.leave_type_id))).map((b) => (
              <div className="kpi" key={String(b.balance_id)}><span className="l">{typeName.get(String(b.leave_type_id)) ?? String(b.leave_type_id)} {String(b.leave_year)}</span><span className="v">{Number(b.available)}</span><span className="l">{Number(b.balance)} in ledger · {Number(b.pending_approval)} pending</span></div>
            ))}
          </div>
        )}
      </Card>
      <Tabs tabs={[{ id: 'mine', label: 'My applications' }, ...(canApprove || me?.role !== 'EMPLOYEE' ? [{ id: 'team', label: 'Team applications' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'mine' && <Card>{mine.error ? <ErrorState error={mine.error} onRetry={mine.reload} /> : <DataTable<Row> columns={appCols(false)} rows={mine.data} loading={mine.loading} exportName="my-leave" />}</Card>}
      {tab === 'team' && <Card>{team.error ? <ErrorState error={team.error} onRetry={team.reload} /> : <DataTable<Row> columns={appCols(true)} rows={team.data} loading={team.loading} exportName="team-leave" />}</Card>}
      {applying && (
        <RequestDialog title="Apply for leave / WFH / OD" url="/api/leave/applications" idempotent
          fields={[{ name: 'leaveTypeId', label: 'Type', type: 'select', required: true, options: (types.data ?? []).map((t) => ({ value: String(t.leave_type_id), label: `${String(t.name)} (${String(t.category)})` })) }, { name: 'fromDate', label: 'From', type: 'date', required: true }, { name: 'toDate', label: 'To', type: 'date', required: true },
            { name: 'halfDay', label: 'Half day', type: 'select', options: ['N', 'Y'], default: 'N', hint: 'Single day only' }, { name: 'reason', label: 'Reason', type: 'textarea' }]}
          build={(v) => ({ leaveTypeId: v.leaveTypeId, fromDate: v.fromDate, toDate: v.toDate || v.fromDate, halfDay: v.halfDay || 'N', reason: v.reason ?? '' })}
          onClose={() => setApplying(false)} onDone={() => { mine.reload(); balances.reload(); }} />
      )}
      {cancelling && <ConfirmDialog title="Cancel application" danger confirmLabel="Cancel application" message={cancelling.status === 'APPROVED' ? 'The approved leave will be reversed in the ledger and your balance restored.' : 'Withdraw this pending application?'} onClose={() => setCancelling(null)} onConfirm={async () => { await run(() => api.post(`/api/leave/applications/${String(cancelling.application_id)}/cancel`, {}), 'Cancelled'); mine.reload(); balances.reload(); }} />}
      {decide && <ConfirmDialog title={`${decide.decision === 'APPROVED' ? 'Approve' : 'Reject'} leave`} danger={decide.decision === 'REJECTED'} withReason={decide.decision === 'REJECTED'} confirmLabel={decide.decision === 'APPROVED' ? 'Approve' : 'Reject'} message="Approval posts the debit to the leave ledger." onClose={() => setDecide(null)}
        onConfirm={async (note) => { await api.post(`/api/leave/applications/${String(decide.row.application_id)}/decision`, { decision: decide.decision, ...(note ? { note } : {}) }); team.reload(); }} />}
      {busy && <span className="sr-only" role="status">Working</span>}
    </>
  );
}
