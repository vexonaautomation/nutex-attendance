'use client';
import { useState } from 'react';
import { api, qs } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { Card, ErrorState, Modal, PageHeader } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';

type Row = Record<string, unknown>;

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const list = useFetch<{ total: number; page: number; pageSize: number; rows: Row[] }>(`/api/audit${qs({ action, entityType, page, pageSize: 50 })}`);
  const [chain, setChain] = useState<string>('');
  const [detail, setDetail] = useState<Row | null>(null);
  const { busy, run } = useAction();
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 50));

  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only. Each row commits to the previous one with a SHA-256 hash, so edits or deletions are detectable." actions={
        <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api.get<{ ok: boolean; checked: number; brokenAt?: string }>('/api/audit/verify')); if (r) setChain(r.ok ? `Chain intact (${r.checked} entries)` : `BROKEN at ${r.brokenAt}`); }}>Verify chain</button>} />
      {chain && <div className={`notice ${chain.startsWith('Chain intact') ? '' : 'bad'}`} role="status">{chain}</div>}
      <Card>
        <div className="row" style={{ marginBottom: 12 }}>
          <input aria-label="Action contains" placeholder="Action contains…" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} style={{ maxWidth: 240 }} />
          <input aria-label="Entity type" placeholder="Entity type (e.g. PAYROLL_PERIOD)" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} style={{ maxWidth: 280 }} />
          <span className="spacer" />
          <span className="muted">{list.data?.total ?? 0} entries</span>
        </div>
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
          <>
            <DataTable<Row> rows={list.data?.rows} loading={list.loading} searchable={false} pageSize={50} exportName="audit" onRowClick={setDetail}
              columns={[{ key: 'timestamp', label: 'When', render: (r) => String(r.timestamp).replace('T', ' ') }, { key: 'actor_user_id', label: 'Actor' }, { key: 'actor_role', label: 'Role' }, { key: 'action', label: 'Action' }, { key: 'entity_type', label: 'Entity' }, { key: 'entity_id', label: 'Id', render: (r) => <span className="mono">{String(r.entity_id).slice(0, 26)}</span> }, { key: 'request_id', label: 'Request', render: (r) => <span className="mono">{String(r.request_id ?? '').slice(0, 8)}</span> }]} />
            <div className="pager"><span>Page {page} / {pages}</span><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button><button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
          </>
        )}
      </Card>
      {detail && (
        <Modal title={String(detail.action)} onClose={() => setDetail(null)}>
          <div className="stack">
            <div className="muted">{String(detail.timestamp)} · {String(detail.actor_user_id)} ({String(detail.actor_role)}) · {String(detail.source)} · {String(detail.ip_address || '')}</div>
            {detail.reason ? <div><b>Reason:</b> {String(detail.reason)}</div> : null}
            <div><b>Before</b><pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{String(detail.before_json || '-')}</pre></div>
            <div><b>After</b><pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{String(detail.after_json || '-')}</pre></div>
            <div className="mono muted">hash {String(detail.entry_hash).slice(0, 24)}… prev {String(detail.prev_hash).slice(0, 24)}…</div>
          </div>
        </Modal>
      )}
    </>
  );
}
