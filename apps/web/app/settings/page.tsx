'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { RequestDialog, useForm } from '@/components/WorkflowPage';
import { ResourcePage } from '@/components/ResourcePage';
import { UserAdmin } from '@/components/UserAdmin';
import { Badge, Card, ErrorState, PageHeader, PasswordInput, Tabs } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';
import { passwordProblem } from '@/lib/password';

type Row = Record<string, unknown>;

function Profile() {
  const { me } = useAuth();
  const fields = [{ name: 'current', label: 'Current password', type: 'text' as const, required: true }, { name: 'next', label: 'New password (8+ characters, letters and digits)', type: 'text' as const, required: true }];
  const f = useForm(fields);
  const { busy, run } = useAction();
  const [problem, setProblem] = useState('');
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <Card title="Your account">
        <div className="stack" style={{ gap: 6 }}><div><b>{me?.name}</b></div><div className="muted">Username: {me?.email}</div><div><Badge value={me?.role} tone="info" /></div><div className="muted">Branches: {me?.locationScope.join(', ') || '-'}</div></div>
      </Card>
      <Card title="Change password">
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          if (!f.check()) return;
          const p = passwordProblem(f.values.next ?? '', me?.email ?? '');
          setProblem(p ?? '');
          if (p) return;
          const r = await run(() => api.post('/api/auth/change-password', f.values), 'Password changed. Your other sessions were signed out.');
          if (r) { f.setValues({}); }
        }}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            {fields.map((x) => (
              <label className="field" key={x.name}><span>{x.label}</span><PasswordInput label={x.label} value={f.values[x.name] ?? ''} onChange={(v) => f.setValues({ ...f.values, [x.name]: v })} autoComplete={x.name === 'current' ? 'current-password' : 'new-password'} minLength={x.name === 'next' ? 8 : 1} /></label>
            ))}
          </div>
          {problem && <div className="notice bad" role="alert">{problem}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>
      </Card>
    </div>
  );
}

function ConfigTable({ canEdit }: { canEdit: boolean }) {
  const list = useFetch<Row[]>('/api/settings');
  const [edit, setEdit] = useState<Row | null>(null);
  return (
    <Card title="System configuration">
      <p className="muted" style={{ marginBottom: 10 }}>Formulas and the check-in rules read these values from the workbook. Every change needs a reason and is written to the audit log. Location rules: PUNCH_REQUIRES_LOCATION, LOCATION_MAX_ACCURACY_M, LOCATION_MAX_AGE_SEC.</p>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
        <DataTable<Row> rows={list.data} loading={list.loading} exportName="system-config" pageSize={25}
          columns={[{ key: 'key', label: 'Key' }, { key: 'value', label: 'Value', render: (r) => <span className="mono">{String(r.value ?? '') || '-'}</span> }, { key: 'type', label: 'Type' }, { key: 'description', label: 'Description' },
            ...(canEdit ? [{ key: '_a', label: '', sortable: false, render: (r: Row) => <button className="btn sm" onClick={() => setEdit(r)}>Edit</button> }] : [])]} />
      )}
      {edit && <RequestDialog title={`Edit ${String(edit.key)}`} url={`/api/settings/${String(edit.key)}`} method="PUT"
        fields={[{ name: 'value', label: `Value (${String(edit.type)})`, type: edit.type === 'date' ? 'date' : 'text', default: String(edit.value ?? '') }, { name: 'reason', label: 'Reason', type: 'text', required: true }]}
        build={(v) => ({ value: edit.type === 'number' || edit.type === 'percent' ? Number(v.value) : v.value, reason: v.reason })} onClose={() => setEdit(null)} onDone={list.reload} />}
    </Card>
  );
}

function SettingsInner() {
  const { can, me } = useAuth();
  const isRoot = me?.role === 'SUPER_ADMIN';
  const tabs = [
    { id: 'profile', label: 'Profile' },
    ...(can('settings') ? [{ id: 'org', label: 'Organisation' }, { id: 'system', label: 'System' }] : []),
    ...(can('users') ? [{ id: 'users', label: 'Logins' }] : []),
  ];
  const wanted = useSearchParams().get('tab');
  const [tab, setTab] = useState(wanted && ['org', 'system', 'users'].includes(wanted) ? wanted : 'profile');
  const [org, setOrg] = useState('locations');
  return (
    <>
      <PageHeader title="Settings" subtitle="Configuration lives in the workbook; changes here are validated, audited and take effect immediately." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'profile' && <Profile />}
      {tab === 'org' && (
        <>
          <Tabs tabs={[{ id: 'locations', label: 'Branches' }, { id: 'departments', label: 'Departments' }, { id: 'designations', label: 'Designations' }, { id: 'leave-types', label: 'Leave types' }, { id: 'leave-policies', label: 'Leave policies' }]} value={org} onChange={setOrg} />
          <ResourcePage key={org} path={org} createLabel="Add"
            description={org === 'locations' ? 'Set each branch latitude and longitude (use "Use my current location" while standing at the branch). With geofence required = Y, check-ins are only accepted within the radius (metres).' : undefined} />
        </>
      )}
      {tab === 'system' && <ConfigTable canEdit={isRoot} />}
      {tab === 'users' && <UserAdmin />}
    </>
  );
}

export default function SettingsPage() {
  return <Suspense fallback={null}><SettingsInner /></Suspense>;
}
