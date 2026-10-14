'use client';
import { useState, type ReactNode } from 'react';
import { api, newKey } from '@/lib/api';
import { useAction, useFetch } from '@/hooks/useApi';
import { Card, ConfirmDialog, ErrorState, Field, Modal } from './ui';
import { DataTable, type Column } from './DataTable';
import { Icon } from './Icon';

type Row = Record<string, unknown>;

export interface SimpleField {
  name: string; label: string; type: 'text' | 'number' | 'date' | 'datetime-local' | 'select' | 'textarea'; options?: string[] | Array<{ value: string; label: string }>; required?: boolean; default?: string; hint?: string;
}

export function SimpleForm({ fields, values, setValues, errors = {} }: { fields: SimpleField[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void; errors?: Record<string, string> }) {
  return (
    <div className="form-grid">
      {fields.map((f) => {
        const v = values[f.name] ?? f.default ?? '';
        const set = (x: string) => setValues({ ...values, [f.name]: x });
        return (
          <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} error={errors[f.name]} hint={f.hint}>
            {f.type === 'select' ? (
              <select value={v} onChange={(e) => set(e.target.value)}>
                <option value="">-</option>
                {(f.options ?? []).map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            ) : f.type === 'textarea' ? <textarea value={v} onChange={(e) => set(e.target.value)} /> : <input type={f.type} value={v} step={f.type === 'number' ? 'any' : undefined} onChange={(e) => set(e.target.value)} />}
          </Field>
        );
      })}
    </div>
  );
}

export function useForm(fields: SimpleField[]) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.filter((f) => f.default).map((f) => [f.name, f.default as string])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const check = () => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.name] ?? '';
      if (f.required && v === '') e[f.name] = 'Required';
      else if (v !== '' && f.type === 'number' && !Number.isFinite(Number(v))) e[f.name] = 'Must be a number';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  return { values, setValues, errors, check };
}

/** create-request modal with a schema of simple fields and an idempotent POST */
export function RequestDialog({ title, fields, url, build, onClose, onDone, idempotent, method = 'POST' }: {
  title: string; fields: SimpleField[]; url: string; build: (v: Record<string, string>) => unknown; onClose: () => void; onDone: () => void; idempotent?: boolean; method?: 'POST' | 'PUT';
}) {
  const f = useForm(fields);
  const { busy, run } = useAction();
  const [key] = useState(newKey);
  return (
    <Modal title={title} onClose={onClose}>
      <SimpleForm fields={fields} values={f.values} setValues={f.setValues} errors={f.errors} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          if (!f.check()) return;
          const body = build(f.values);
          const r = await run(() => (method === 'PUT' ? api.put(url, body) : idempotent ? api.idem(url, body, key) : api.post(url, body)), 'Submitted');
          if (r !== undefined) { onDone(); onClose(); }
        }}>{busy ? 'Submitting…' : 'Submit'}</button>
      </div>
    </Modal>
  );
}

/** list + create + approve/reject for a request-style module (overtime, timesheets, expenses, ...) */
export function WorkflowPage({ title, description, listUrl, columns, createFields, createUrl, buildBody, canCreate, canDecide, decisionUrl, idKey, extra, createLabel = 'New request', exportName, idempotent, decisionWithMinutes }: {
  title: string; description?: string; listUrl: string; columns: Column<Row>[]; createFields?: SimpleField[]; createUrl?: string; buildBody?: (v: Record<string, string>) => unknown;
  canCreate: boolean; canDecide: boolean; decisionUrl?: (id: string) => string; idKey: string; extra?: ReactNode; createLabel?: string; exportName: string; idempotent?: boolean; decisionWithMinutes?: boolean;
}) {
  const list = useFetch<Row[]>(listUrl);
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<{ row: Row; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const [minutes, setMinutes] = useState('');

  const cols: Column<Row>[] = [...columns];
  if (canDecide && decisionUrl) {
    cols.push({
      key: '_d', label: '', sortable: false,
      render: (r) => r.status === 'PENDING' ? (
        <span className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" onClick={() => { setMinutes(String(r.requested_minutes ?? '')); setDeciding({ row: r, decision: 'APPROVED' }); }}>Approve</button>
          <button className="btn sm danger" onClick={() => setDeciding({ row: r, decision: 'REJECTED' })}>Reject</button>
        </span>
      ) : null,
    });
  }
  return (
    <>
      <Card title={title} actions={canCreate && createFields && createUrl && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> {createLabel}</button>}>
        {description && <p className="muted" style={{ marginBottom: 12 }}>{description}</p>}
        {extra}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : <DataTable<Row> columns={cols} rows={list.data} loading={list.loading} exportName={exportName} />}
      </Card>
      {creating && createFields && createUrl && buildBody && <RequestDialog title={createLabel} fields={createFields} url={createUrl} build={buildBody} onClose={() => setCreating(false)} onDone={list.reload} idempotent={idempotent} />}
      {deciding && decisionUrl && (
        <ConfirmDialog title={`${deciding.decision === 'APPROVED' ? 'Approve' : 'Reject'} request`} danger={deciding.decision === 'REJECTED'} confirmLabel={deciding.decision === 'APPROVED' ? 'Approve' : 'Reject'} withReason={deciding.decision === 'REJECTED'}
          message={<>{decisionWithMinutes && deciding.decision === 'APPROVED' ? <Field label="Approved minutes"><input type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field> : 'Confirm your decision. It is recorded in the audit log.'}</>}
          onClose={() => setDeciding(null)}
          onConfirm={async (note) => {
            await api.post(decisionUrl(String(deciding.row[idKey])), { decision: deciding.decision, ...(note ? { note } : {}), ...(decisionWithMinutes && deciding.decision === 'APPROVED' && minutes ? { approvedMinutes: Number(minutes) } : {}) });
            list.reload();
          }} />
      )}
    </>
  );
}
