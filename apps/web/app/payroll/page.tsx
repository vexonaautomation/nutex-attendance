'use client';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { RequestDialog, SimpleForm, useForm } from '@/components/WorkflowPage';
import { Badge, Card, ConfirmDialog, ErrorState, Loading, Modal, PageHeader } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';
import { inr } from '@/lib/format';
import { Icon } from '@/components/Icon';

type Row = Record<string, unknown>;
const STEPS = ['OPEN', 'PROCESSING', 'REVIEW', 'APPROVED', 'LOCKED'];
const NEXT: Record<string, string> = { OPEN: 'PROCESSING', PROCESSING: 'REVIEW', REVIEW: 'APPROVED', APPROVED: 'LOCKED' };
const BACK: Record<string, string> = { PROCESSING: 'OPEN', REVIEW: 'PROCESSING', APPROVED: 'REVIEW' };
const NEXT_LABEL: Record<string, string> = { PROCESSING: 'Start processing', REVIEW: 'Submit for review', APPROVED: 'Approve payroll', LOCKED: 'Lock payroll' };

function Stepper({ status }: { status: string }) {
  const at = STEPS.indexOf(status);
  return (
    <ol className="row" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Payroll lifecycle">
      {STEPS.map((s, i) => <li key={s}><Badge value={s} tone={i < at ? 'ok' : i === at ? 'info' : 'neutral'} /></li>)}
    </ol>
  );
}

function InputDialog({ periodId, row, onClose, onDone }: { periodId: string; row: Row; onClose: () => void; onDone: () => void }) {
  const fields = [
    { name: 'bonus', label: 'Bonus', type: 'number' as const }, { name: 'incentive', label: 'Incentive', type: 'number' as const }, { name: 'arrears', label: 'Arrears (approved)', type: 'number' as const },
    { name: 'manual_adjustment', label: 'Manual adjustment (+/-)', type: 'number' as const }, { name: 'manual_adjustment_reason', label: 'Adjustment reason', type: 'text' as const, hint: 'Required with an adjustment' },
    { name: 'other_deduction', label: 'Other deduction', type: 'number' as const }, { name: 'tds_manual_flag', label: 'Manual TDS', type: 'select' as const, options: ['N', 'Y'], default: 'N' }, { name: 'tds_manual_amount', label: 'TDS amount', type: 'number' as const },
  ];
  const f = useForm(fields);
  const { busy, run } = useAction();
  return (
    <Modal title={`Payroll inputs · ${String(row.employee_id)}`} onClose={onClose}>
      <SimpleForm fields={fields} values={f.values} setValues={f.setValues} errors={f.errors} />
      <p className="muted" style={{ marginTop: 8 }}>Only the fields you fill in are changed. The change is audited with before / after values.</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          if (!f.check()) return;
          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(f.values)) if (v !== '') body[k] = ['manual_adjustment_reason', 'tds_manual_flag'].includes(k) ? v : Number(v);
          if (!Object.keys(body).length) return;
          const r = await run(() => api.patch(`/api/payroll/periods/${periodId}/inputs/${String(row.employee_id)}`, body), 'Inputs saved');
          if (r !== undefined) { onDone(); onClose(); }
        }}>Save</button>
      </div>
    </Modal>
  );
}

function Detail({ periodId, onChanged }: { periodId: string; onChanged: () => void }) {
  const { can, me } = useAuth();
  const period = useFetch<Row>(`/api/payroll/periods/${periodId}`);
  const rows = useFetch<{ source: string; rows: Row[] }>(`/api/payroll/periods/${periodId}/rows`);
  const emps = useFetch<Row[]>(can('employees') ? '/api/r/employees' : null);
  const names = useMemo(() => new Map((emps.data ?? []).map((e) => [String(e.employee_id), `${String(e.first_name)} ${String(e.last_name ?? '')}`.trim()])), [emps.data]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [verify, setVerify] = useState<string>('');
  const { busy, run } = useAction();

  if (period.error) return <ErrorState error={period.error} onRetry={period.reload} />;
  if (!period.data) return <Loading />;
  const p = period.data;
  const status = String(p.status);
  const editable = ['OPEN', 'PROCESSING', 'REVIEW'].includes(status);
  const reload = () => { period.reload(); rows.reload(); onChanged(); };
  const next = NEXT[status];
  const needsApprove = next === 'APPROVED' || next === 'LOCKED';
  const allowedNext = next && (needsApprove ? can('payroll', 'approve') : can('payroll', 'write'));
  const transition = async (to: string, note?: string) => { await api.post(`/api/payroll/periods/${periodId}/transition`, { to, ...(note ? { note } : {}) }); reload(); };

  const cols = [
    { key: 'employee_id', label: 'Employee', render: (r: Row) => names.get(String(r.employee_id)) ?? String(r.employee_id), value: (r: Row) => names.get(String(r.employee_id)) ?? String(r.employee_id) },
    { key: 'paid_days', label: 'Paid days', align: 'num' as const }, { key: 'lop_days', label: 'LOP', align: 'num' as const },
    { key: 'gross_earnings', label: 'Gross', align: 'num' as const, render: (r: Row) => inr(r.gross_earnings), value: (r: Row) => Number(r.gross_earnings) },
    { key: 'total_deductions', label: 'Deductions', align: 'num' as const, render: (r: Row) => inr(r.total_deductions), value: (r: Row) => Number(r.total_deductions) },
    { key: 'net_pay', label: 'Net pay', align: 'num' as const, render: (r: Row) => <b>{inr(r.net_pay)}</b>, value: (r: Row) => Number(r.net_pay) },
    { key: 'employer_cost', label: 'Employer cost', align: 'num' as const, render: (r: Row) => inr(r.employer_cost), value: (r: Row) => Number(r.employer_cost) },
    ...(rows.data?.source === 'LIVE' ? [{ key: 'check_status', label: 'Check', render: (r: Row) => <Badge value={r.check_status} tone={r.check_status === 'OK' ? 'ok' : 'bad'} /> }] : []),
    ...(editable && can('payroll', 'write') ? [{ key: '_a', label: '', sortable: false, render: (r: Row) => <button className="btn sm" onClick={() => setEditing(r)}>Inputs</button> }] : []),
  ];
  const totals = rows.data?.rows.reduce<Record<string, number>>((t, r) => ({ gross_earnings: (t.gross_earnings ?? 0) + Number(r.gross_earnings), total_deductions: (t.total_deductions ?? 0) + Number(r.total_deductions), net_pay: (t.net_pay ?? 0) + Number(r.net_pay), employer_cost: (t.employer_cost ?? 0) + Number(r.employer_cost) }), {});

  return (
    <>
      <Card title={`${String(p.period_label)} · ${String(p.run_type)}`} actions={<Stepper status={status} />}>
        <div className="grid cols-4">
          <div className="kpi"><span className="v">{String(p.employee_rows)}</span><span className="l">employees</span></div>
          <div className="kpi"><span className="v">{inr(p.total_net)}</span><span className="l">net pay</span></div>
          <div className="kpi"><span className="v">{inr(p.total_employer_cost)}</span><span className="l">employer cost</span></div>
          <div className="kpi"><span className="v">{String(p.issue_count)}</span><span className="l">rows needing attention</span></div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          {status !== 'LOCKED' && BACK[status] && can('payroll', 'write') && <button className="btn" disabled={busy} onClick={() => void run(() => transition(BACK[status]), 'Moved back')}>Back to {BACK[status].toLowerCase()}</button>}
          {allowedNext && <button className="btn primary" disabled={busy || (next === 'APPROVED' && p.ready_to_approve !== 'YES')} onClick={() => setConfirm(next)}>{NEXT_LABEL[next]}</button>}
          {next === 'APPROVED' && p.ready_to_approve !== 'YES' && <span className="muted">Fix the flagged rows before approval.</span>}
          {next === 'APPROVED' && String(p.submitted_by) === me?.userId && <span className="muted">Maker-checker: someone else must approve.</span>}
          <span className="spacer" />
          {['APPROVED', 'LOCKED'].includes(status) && can('payroll', 'export') && (['register', 'bank', 'pf', 'esi'] as const).map((k) => <a key={k} className="btn sm" href={`/api/payroll/periods/${periodId}/export/${k}`}><Icon name="download" size={14} /> {k}</a>)}
        </div>
        {status === 'LOCKED' && (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api.get<{ rowsOk: boolean; periodHashOk: boolean; rows: number }>(`/api/payroll/periods/${periodId}/verify-snapshot`)); if (r) setVerify(r.rowsOk && r.periodHashOk ? `Snapshot verified: ${r.rows} rows intact.` : 'SNAPSHOT MISMATCH: investigate immediately.'); }}>Verify snapshot</button>
            {can('payslips', 'write') && <button className="btn" disabled={busy} onClick={() => void run(() => api.post(`/api/payroll/periods/${periodId}/payslips`), 'Payslips generated')}>Generate payslips</button>}
            {verify && <span className={verify.startsWith('Snapshot verified') ? 'badge ok' : 'badge bad'}>{verify}</span>}
          </div>
        )}
        {status === 'LOCKED' && <div className="notice" style={{ marginTop: 12 }}>This period is <b>locked</b>. Figures below come from the immutable snapshot taken at lock time and stay reproducible after salary, rule or policy changes.</div>}
      </Card>
      <Card title="Payroll register" actions={rows.data && <Badge value={rows.data.source} tone={rows.data.source === 'SNAPSHOT' ? 'ok' : 'info'} />}>
        {rows.error ? <ErrorState error={rows.error} onRetry={rows.reload} /> : <DataTable<Row> columns={cols} rows={rows.data?.rows} loading={rows.loading} exportName={`payroll-${periodId}`} totals={totals} empty={{ title: 'No payroll rows', hint: 'Move the period to PROCESSING to create one row per employee.' }} />}
      </Card>
      {confirm && (
        <ConfirmDialog title={NEXT_LABEL[confirm]} danger={confirm === 'LOCKED'} confirmLabel={NEXT_LABEL[confirm]} withReason={false}
          message={confirm === 'LOCKED' ? 'Locking writes an immutable snapshot and marks loan installments as deducted. A locked period can never be changed; corrections go into arrears or an off-cycle run.' : confirm === 'APPROVED' ? 'Approving freezes all inputs. You are confirming the register is correct.' : 'Continue?'}
          onClose={() => setConfirm(null)} onConfirm={() => run(() => transition(confirm), `${NEXT_LABEL[confirm]}: done`).then(() => undefined)} />
      )}
      {editing && <InputDialog periodId={periodId} row={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </>
  );
}

function PayrollInner() {
  const { can } = useAuth();
  const router = useRouter();
  const sel = useSearchParams().get('period');
  const periods = useFetch<Row[]>('/api/payroll/periods');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Payroll" subtitle="OPEN → PROCESSING → REVIEW → APPROVED → LOCKED. All calculations run in the workbook formulas; this screen drives the workflow." actions={can('payroll', 'write') && <button className="btn primary" onClick={() => setCreating(true)}>New period</button>} />
      <Card title="Periods">
        {periods.error ? <ErrorState error={periods.error} onRetry={periods.reload} /> : (
          <DataTable<Row> rows={periods.data} loading={periods.loading} exportName="payroll-periods" searchable={false} onRowClick={(r) => router.push(`/payroll?period=${encodeURIComponent(String(r.period_id))}`)}
            columns={[{ key: 'period_label', label: 'Period' }, { key: 'period_id', label: 'Id' }, { key: 'run_type', label: 'Run' }, { key: 'period_start', label: 'From' }, { key: 'period_end', label: 'To' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
              { key: 'employee_rows', label: 'Rows', align: 'num' }, { key: 'total_net', label: 'Net', align: 'num', render: (r) => inr(r.total_net), value: (r) => Number(r.total_net) }, { key: 'issue_count', label: 'Issues', align: 'num' }]} />
        )}
      </Card>
      {sel ? <Detail key={sel} periodId={sel} onChanged={periods.reload} /> : <div className="notice">Select a period to review its register and move it through the workflow.</div>}
      {creating && (
        <RequestDialog title="New payroll period" url="/api/payroll/periods"
          fields={[{ name: 'periodId', label: 'Period id', type: 'text', required: true, hint: 'e.g. PR-2026-10 or PR-OC-2026-10' }, { name: 'label', label: 'Label', type: 'text', required: true }, { name: 'start', label: 'Start', type: 'date', required: true }, { name: 'end', label: 'End', type: 'date', required: true }, { name: 'runType', label: 'Run type', type: 'select', options: ['REGULAR', 'OFF_CYCLE'], default: 'REGULAR', required: true }]}
          build={(v) => v} onClose={() => setCreating(false)} onDone={periods.reload} />
      )}
    </>
  );
}

export default function PayrollPage() {
  return <Suspense fallback={<Loading />}><PayrollInner /></Suspense>;
}
