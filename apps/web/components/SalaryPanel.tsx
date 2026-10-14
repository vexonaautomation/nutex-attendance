'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useFetch } from '@/hooks/useApi';
import { dateOnly, inr, isoDay } from '@/lib/format';
import { DataTable } from './DataTable';
import { Card, ErrorState, Field, Modal } from './ui';
import { Icon } from './Icon';

export type SalaryRow = Record<string, unknown>;

const PARTS: Array<[string, string]> = [
  ['basic', 'Basic'], ['hra', 'HRA'], ['da', 'DA'], ['conveyance', 'Conveyance'], ['special_allowance', 'Special allowance'], ['other_allowance', 'Other allowance'],
  ['custom_earning_1', 'Custom earning 1'], ['custom_earning_2', 'Custom earning 2'],
];
const sum = (r: SalaryRow) => PARTS.reduce((n, [k]) => n + Number(r[k] ?? 0), 0);

/** the structure that applies today: the latest row whose effective date has arrived */
export function currentStructure(rows: SalaryRow[]): SalaryRow | undefined {
  const today = isoDay();
  return [...rows].filter((r) => r.status !== 'INACTIVE' && String(r.effective_from ?? '') <= today).sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
}

function SalaryDialog({ employeeId, previous, count, onClose, onDone }: { employeeId: string; previous?: SalaryRow; count: number; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [reason, setReason] = useState(previous ? 'Revision' : 'Joining');
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(PARTS.map(([k]) => [k, previous && previous[k] != null ? String(previous[k]) : ''])));
  const { busy, run } = useAction();
  const gross = PARTS.reduce((n, [k]) => n + (Number(vals[k]) || 0), 0);
  const bad = PARTS.some(([k]) => vals[k] !== '' && !(Number(vals[k]) >= 0)) || !from || gross <= 0;
  return (
    <Modal title={previous ? 'Revise salary' : 'Set salary'} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 12 }}>Monthly amounts in rupees. A revision is saved as a new dated row; earlier rows are never changed, so past payroll stays reproducible.</p>
      <div className="form-grid">
        <Field label="Effective from *"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} /></Field>
        {PARTS.map(([k, l]) => (
          <Field key={k} label={`${l} (monthly)`}><input type="number" min={0} step="any" inputMode="decimal" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></Field>
        ))}
      </div>
      <p style={{ marginTop: 12 }}>Monthly gross: <b>{inr(gross)}</b></p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || bad} onClick={async () => {
          const body: Record<string, unknown> = { employee_id: employeeId, effective_from: from, revision_reason: reason, version: count + 1 };
          for (const [k] of PARTS) if (vals[k] !== '') body[k] = Number(vals[k]);
          const r = await run(() => api.post('/api/r/salaries', body), 'Salary saved');
          if (r) { onDone(); onClose(); }
        }}>{busy ? 'Saving…' : 'Save salary'}</button>
      </div>
    </Modal>
  );
}

/**
 * Salary structure of one employee. `canWrite` (owner / finance) shows the set / revise button; everyone else sees their own
 * structure read-only (the server only returns rows the caller may read).
 */
export function SalaryPanel({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const all = useFetch<SalaryRow[]>('/api/r/salaries');
  const [dialog, setDialog] = useState(false);
  const rows = (all.data ?? []).filter((r) => r.employee_id === employeeId);
  const cur = currentStructure(rows);
  return (
    <Card title="Salary structure" actions={canWrite && <button className="btn primary" onClick={() => setDialog(true)}><Icon name="plus" size={16} /> {cur ? 'Revise salary' : 'Set salary'}</button>}>
      {all.error ? <ErrorState error={all.error} onRetry={all.reload} /> : (
        <div className="stack">
          {cur ? (
            <div className="grid cols-4">
              <div className="kpi"><span className="v">{inr(cur.monthly_gross ?? sum(cur))}</span><span className="l">monthly gross, from {dateOnly(cur.effective_from)}</span></div>
              {PARTS.filter(([k]) => Number(cur[k] ?? 0) > 0).map(([k, l]) => <div className="kpi" key={k}><span className="v">{inr(cur[k])}</span><span className="l">{l}</span></div>)}
            </div>
          ) : <p className="muted">{canWrite ? 'No salary is set yet. Payroll marks this person "no salary structure" until you set one.' : 'No salary structure has been set for you yet.'}</p>}
          {rows.length > 0 && (
            <DataTable<SalaryRow> rows={rows} loading={all.loading} searchable={false} exportName={`salary-${employeeId}`}
              columns={[{ key: 'effective_from', label: 'From', render: (r) => dateOnly(r.effective_from) }, { key: 'basic', label: 'Basic', align: 'num' }, { key: 'hra', label: 'HRA', align: 'num' }, { key: 'da', label: 'DA', align: 'num' },
                { key: 'conveyance', label: 'Conv.', align: 'num' }, { key: 'special_allowance', label: 'Special', align: 'num' }, { key: 'monthly_gross', label: 'Gross', align: 'num' }, { key: 'revision_reason', label: 'Reason' }]} />
          )}
        </div>
      )}
      {dialog && <SalaryDialog employeeId={employeeId} previous={cur} count={rows.length} onClose={() => setDialog(false)} onDone={all.reload} />}
    </Card>
  );
}
