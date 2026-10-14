'use client';
import { useMemo, useState } from 'react';
import { qs } from '@/lib/api';
import { DataTable, type Column } from '@/components/DataTable';
import { Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '@/components/ui';
import { useFetch } from '@/hooks/useApi';
import { inr, isoDay, monthRange } from '@/lib/format';
import { Icon } from '@/components/Icon';

interface Col { key: string; label: string; type?: string; sum?: boolean }
interface Def { id: string; title: string; description: string; params: Array<{ name: string; label: string; type: string; required?: boolean }>; columns: Col[] }
interface Result { columns: Col[]; rows: Array<Record<string, unknown>>; total: number; totals: Record<string, number> }

export default function ReportsPage() {
  const list = useFetch<Def[]>('/api/reports');
  const [id, setId] = useState('');
  const [params, setParams] = useState<Record<string, string>>({ from: monthRange(isoDay().slice(0, 7)).from, to: isoDay(), period: 'PR-2026-09' });
  const [run, setRun] = useState<string | null>(null);
  const def = list.data?.find((d) => d.id === id);
  const missing = def?.params.filter((p) => p.required && !params[p.name]) ?? [];
  const url = run && def ? `/api/reports/${def.id}${qs({ ...Object.fromEntries(def.params.map((p) => [p.name, params[p.name]])), pageSize: 1000 })}` : null;
  const res = useFetch<Result>(url);
  const csvUrl = def ? `/api/reports/${def.id}${qs({ ...Object.fromEntries(def.params.map((p) => [p.name, params[p.name]])), format: 'csv' })}` : '';

  const columns = useMemo<Column<Record<string, unknown>>[]>(() => (res.data?.columns ?? []).map((c) => ({
    key: c.key, label: c.label, align: c.type === 'number' || c.type === 'money' ? ('num' as const) : undefined,
    render: (r) => (c.type === 'money' ? inr(r[c.key]) : String(r[c.key] ?? '') || <span className="muted">-</span>), value: (r) => r[c.key] as string | number,
  })), [res.data]);

  return (
    <>
      <PageHeader title="Reports" subtitle="Sheet-backed. Locked payroll periods are reported from the immutable snapshot." />
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card title="Choose a report">
            <div className="stack" style={{ gap: 6 }}>
              {list.data.map((d) => (
                <button key={d.id} className={`btn ${id === d.id ? 'primary' : ''}`} style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => { setId(d.id); setRun(null); }} aria-pressed={id === d.id}>
                  <span><b>{d.title}</b><br /><small style={{ fontWeight: 400 }}>{d.description}</small></span>
                </button>
              ))}
            </div>
          </Card>
          <Card title={def ? def.title : 'Parameters'}>
            {!def ? <EmptyState title="Pick a report" /> : (
              <div className="stack">
                <div className="form-grid">
                  {def.params.map((p) => (
                    <Field key={p.name} label={`${p.label}${p.required ? ' *' : ''}`}>
                      <input type={p.type === 'date' ? 'date' : 'text'} value={params[p.name] ?? ''} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} />
                    </Field>
                  ))}
                </div>
                <div className="row">
                  <button className="btn primary" disabled={missing.length > 0} onClick={() => { setRun(`${id}:${JSON.stringify(params)}`); }}>Run report</button>
                  <a className="btn" href={csvUrl} aria-disabled={missing.length > 0} style={missing.length ? { pointerEvents: 'none', opacity: 0.5 } : undefined}><Icon name="download" size={15} /> Download CSV</a>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
      {def && run && (
        <Card title={`${def.title} · ${res.data?.total ?? 0} rows`}>
          {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : <DataTable<Record<string, unknown>> columns={columns} rows={res.data?.rows} loading={res.loading} exportName={def.id} totals={res.data?.totals} pageSize={20} empty={{ title: 'No rows for these parameters' }} />}
        </Card>
      )}
    </>
  );
}
