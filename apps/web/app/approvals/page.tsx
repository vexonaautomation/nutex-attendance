'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { Badge, Card, ConfirmDialog, ErrorState, PageHeader } from '@/components/ui';
import { useFetch } from '@/hooks/useApi';

interface Item { type: string; id: string; employeeId: string; summary: string; date: string }

const ENDPOINT: Record<string, (id: string) => string> = {
  LEAVE: (id) => `/api/leave/applications/${id}/decision`,
  REGULARISATION: (id) => `/api/attendance/adjustments/${id}/decision`,
  OVERTIME: (id) => `/api/overtime/${id}/decision`,
  TIMESHEET: (id) => `/api/timesheets/${id}/decision`,
  EXPENSE: (id) => `/api/expenses/${id}/decision`,
};

export default function ApprovalsPage() {
  const inbox = useFetch<Item[]>('/api/approvals');
  const [deciding, setDeciding] = useState<{ item: Item; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  return (
    <>
      <PageHeader title="Approvals" subtitle="Everything waiting for your decision, across leave, regularisation, overtime, timesheets and expenses. You never see (or approve) your own requests." />
      <Card>
        {inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.reload} /> : (
          <DataTable<Item & Record<string, unknown>> rows={inbox.data as never} loading={inbox.loading} exportName="approvals" empty={{ title: 'All caught up', hint: 'No requests are waiting for you.' }}
            columns={[{ key: 'type', label: 'Type', render: (r) => <Badge value={r.type} tone="info" /> }, { key: 'employeeId', label: 'Employee' }, { key: 'summary', label: 'Request' }, { key: 'date', label: 'Submitted', render: (r) => String(r.date).slice(0, 10) },
              { key: '_a', label: '', sortable: false, render: (r) => <span className="row" style={{ gap: 6 }}><button className="btn sm primary" onClick={() => setDeciding({ item: r, decision: 'APPROVED' })}>Approve</button><button className="btn sm danger" onClick={() => setDeciding({ item: r, decision: 'REJECTED' })}>Reject</button></span> }]} />
        )}
      </Card>
      {deciding && (
        <ConfirmDialog title={`${deciding.decision === 'APPROVED' ? 'Approve' : 'Reject'} ${deciding.item.type.toLowerCase()}`} danger={deciding.decision === 'REJECTED'} withReason={deciding.decision === 'REJECTED'} confirmLabel={deciding.decision === 'APPROVED' ? 'Approve' : 'Reject'}
          message={<>{deciding.item.summary}<br /><span className="muted">The decision is written to the audit log.</span></>} onClose={() => setDeciding(null)}
          onConfirm={async (note) => { await api.post(ENDPOINT[deciding.item.type](deciding.item.id), { decision: deciding.decision, ...(note ? { note } : {}) }); inbox.reload(); }} />
      )}
    </>
  );
}
