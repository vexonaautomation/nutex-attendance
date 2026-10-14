'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useFetch } from '@/hooks/useApi';
import { FieldMeta, inputTypeFor, labelOf, optionsFor, toFormValues, toPayload, validate } from '@/lib/forms';
import { dateOnly } from '@/lib/format';
import { LocationError, acquireLocation, locationAdvice } from '@/lib/location';
import { DataTable, type Column } from './DataTable';
import { Badge, Card, ConfirmDialog, ErrorState, Field, Loading, Modal } from './ui';
import { Icon } from './Icon';

interface Meta { path: string; tab: string; key: string; versioned: boolean; canWrite: boolean; columns: FieldMeta[] }
type Row = Record<string, unknown>;

/** form for the input columns of any tab, generated from the workbook schema served by the API */
export function SchemaForm({ fields, values, setValues, errors }: { fields: FieldMeta[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void; errors: Record<string, string> }) {
  return (
    <div className="form-grid">
      {fields.map((f) => {
        const t = inputTypeFor(f);
        const v = values[f.name] ?? '';
        const set = (x: string) => setValues({ ...values, [f.name]: x });
        return (
          <Field key={f.name} label={`${labelOf(f.name)}${f.required ? ' *' : ''}`} error={errors[f.name]} hint={f.note}>
            {t === 'select' ? (
              <select value={v} onChange={(e) => set(e.target.value)}><option value="">-</option>{optionsFor(f).map((o) => <option key={o} value={o}>{o}</option>)}</select>
            ) : t === 'textarea' ? (
              <textarea value={v} onChange={(e) => set(e.target.value)} />
            ) : (
              <input type={t} value={v} step={t === 'number' ? 'any' : undefined} onChange={(e) => set(e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

const SHOW_LIMIT = 8;

/** Searchable, exportable list + create / edit / archive for one master-data resource. */
export function ResourcePage({ path, title, columns, hideFields = [], createLabel = 'Add', description, rowActions, onCreated }: {
  path: string; title?: string; columns?: string[]; hideFields?: string[]; createLabel?: string; description?: string; rowActions?: (r: Row) => React.ReactNode; onCreated?: (row: Row) => void;
}) {
  const meta = useFetch<Meta>(`/api/r/${path}/meta`);
  const list = useFetch<Row[]>(`/api/r/${path}`);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Row | null>(null);
  const { run } = useAction();

  const fields = useMemo(() => (meta.data?.columns ?? []).filter((c) => c.editable && !hideFields.includes(c.name)), [meta.data, hideFields]);
  const shown = useMemo<Column<Row>[]>(() => {
    const all = meta.data?.columns ?? [];
    const names = columns ?? all.filter((c) => !['company_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'source', 'request_id', 'notes'].includes(c.name)).map((c) => c.name).slice(0, SHOW_LIMIT);
    return names.map((n) => {
      const c = all.find((x) => x.name === n);
      return {
        key: n, label: labelOf(n), align: c && ['number', 'money', 'percent'].includes(c.type) ? ('num' as const) : undefined,
        render: (r: Row) => (n === 'status' || n.endsWith('_status') ? <Badge value={r[n]} /> : c?.type === 'date' ? dateOnly(r[n]) : String(r[n] ?? '') || <span className="muted">-</span>),
        value: (r: Row) => r[n] as string,
      };
    });
  }, [meta.data, columns]);

  if (meta.error) return <ErrorState error={meta.error} onRetry={meta.reload} />;
  if (!meta.data) return <Loading />;
  const m = meta.data;
  return (
    <Card title={title} actions={m.canWrite && <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> {createLabel}</button>}>
      {description && <p className="muted" style={{ marginBottom: 12 }}>{description}</p>}
      {m.versioned && <div className="notice" style={{ marginBottom: 12 }}>Effective-dated data: changes are made by adding a new version, never by editing history.</div>}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
        <DataTable<Row> columns={[...shown, ...(m.canWrite || rowActions ? [{ key: '_a', label: '', sortable: false, render: (r: Row) => (
          <span className="row" style={{ gap: 6 }}>
            {rowActions?.(r)}
            {m.canWrite && !m.versioned && <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>}
            {m.canWrite && !m.versioned && r.status !== 'INACTIVE' && <button className="btn sm danger" onClick={() => setArchiving(r)}>{path === 'employees' ? 'Remove' : 'Archive'}</button>}
            {m.canWrite && !m.versioned && r.status === 'INACTIVE' && (
              <button className="btn sm" onClick={async () => { await run(() => api.post(`/api/r/${path}/${encodeURIComponent(String(r[m.key]))}/restore`), 'Restored'); list.reload(); }}>Restore</button>
            )}
          </span>) } as Column<Row>] : [])]}
        rows={list.data} loading={list.loading} exportName={path} />
      )}
      {editing && <EditDialog path={path} meta={m} fields={fields} row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(saved, isNew) => { setEditing(null); list.reload(); if (isNew && saved) onCreated?.(saved); }} />}
      {archiving && (
        <ConfirmDialog title={path === 'employees' ? 'Remove employee' : 'Archive record'} danger withReason confirmLabel={path === 'employees' ? 'Remove' : 'Archive'}
          message={path === 'employees'
            ? <>Remove <b>{String(archiving[m.key])}</b>? They can no longer check in and their login is disabled. Nothing is deleted: attendance, leave and payroll history stay, and you can restore them later. To end employment properly for payroll, set a date of exit instead.</>
            : <>Archive <b>{String(archiving[m.key])}</b>? It stays in the workbook with status INACTIVE (nothing is deleted).</>}
          onClose={() => setArchiving(null)} onConfirm={async (reason) => { await api.post(`/api/r/${path}/${encodeURIComponent(String(archiving[m.key]))}/archive`, { reason }); list.reload(); }} />
      )}
    </Card>
  );
}

function EditDialog({ path, meta, fields, row, onClose, onSaved }: { path: string; meta: Meta; fields: FieldMeta[]; row: Row | null; onClose: () => void; onSaved: (saved: Row | undefined, isNew: boolean) => void }) {
  const editable = row ? fields.filter((f) => f.name !== meta.key) : fields;
  const [values, setValues] = useState<Record<string, string>>(row ? toFormValues(editable, row) : {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const [locating, setLocating] = useState('');
  const hasCoords = editable.some((f) => f.name === 'latitude') && editable.some((f) => f.name === 'longitude');
  async function fillFromDevice() {
    setLocating('Getting your location…');
    try {
      const fix = await acquireLocation({ targetAccuracyM: 30, timeoutMs: 25_000, onProgress: (f) => setLocating(`Accuracy about ${Math.round(f.accuracy)} m…`) });
      setValues((v) => ({ ...v, latitude: fix.lat.toFixed(6), longitude: fix.lng.toFixed(6) }));
      setLocating(`Filled from this device (accuracy about ${Math.round(fix.accuracy)} m).`);
    } catch (e) {
      if (e instanceof LocationError && e.best) {
        setValues((v) => ({ ...v, latitude: e.best!.lat.toFixed(6), longitude: e.best!.lng.toFixed(6) }));
        setLocating(`Filled, but only accurate to about ${Math.round(e.best.accuracy)} m. Try again outdoors for a better fix.`);
      } else setLocating(e instanceof LocationError ? locationAdvice(e.code, { secure: typeof isSecureContext === 'undefined' ? true : isSecureContext, protocol: location.protocol }) : 'Could not get the location.');
    }
  }
  return (
    <Modal title={row ? `Edit ${String(row[meta.key])}` : 'New record'} onClose={onClose}>
      {hasCoords && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <button type="button" className="btn sm" onClick={() => void fillFromDevice()}><Icon name="pin" size={14} /> Use my current location</button>
          {locating && <span style={{ marginLeft: 10 }}>{locating}</span>}
        </div>
      )}
      <SchemaForm fields={editable} values={values} setValues={setValues} errors={errors} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          const errs = validate(editable, values);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          const body = toPayload(editable, values);
          const ok = await run(() => (row ? api.patch(`/api/r/${path}/${encodeURIComponent(String(row[meta.key]))}`, body) : api.post(`/api/r/${path}`, body)), 'Saved');
          if (ok !== undefined) onSaved(ok as Row, !row);
        }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
