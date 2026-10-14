'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { PageHeader } from '@/components/ui';
import { ResourcePage } from '@/components/ResourcePage';
import { IssueLoginDialog, type EmployeeLite } from '@/components/UserAdmin';

export default function EmployeesPage() {
  const { can } = useAuth();
  const canLogin = can('users', 'write');
  const [offer, setOffer] = useState<EmployeeLite | null>(null);
  return (
    <>
      <PageHeader title="Employees" subtitle="Add people, set their salary and give each one a username and password. Branch, team and self scope are enforced by the server." />
      <ResourcePage
        path="employees" createLabel="Add employee"
        columns={['employee_code', 'first_name', 'last_name', 'department_id', 'location_id', 'employment_type', 'employee_status', 'date_of_joining']}
        hideFields={['bank_account_ref', 'bank_ifsc']}
        onCreated={(r) => { if (canLogin) setOffer({ employee_id: String(r.employee_id), employee_code: String(r.employee_code), first_name: String(r.first_name), last_name: String(r.last_name ?? ''), location_id: String(r.location_id ?? ''), status: String(r.status ?? '') }); }}
        rowActions={(r) => (
          <>
            <Link className="btn sm" href={`/employees/${encodeURIComponent(String(r.employee_id))}`}>Profile</Link>
            {canLogin && r.status !== 'INACTIVE' && <Link className="btn sm primary" href={`/employees/${encodeURIComponent(String(r.employee_id))}?tab=login`}>Login / password</Link>}
          </>
        )}
      />
      {offer && (
        <div className="notice" role="status" style={{ marginTop: 12 }}>
          <b>{offer.first_name} {offer.last_name}</b> was added. Give them a username and password now so they can check in?
          <span className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn sm primary" onClick={() => setOffer({ ...offer, status: 'ASK' })}>Create login</button>
            <button className="btn sm" onClick={() => setOffer(null)}>Later</button>
          </span>
        </div>
      )}
      {offer?.status === 'ASK' && <IssueLoginDialog employees={[]} fixed={{ ...offer, status: 'ACTIVE' }} onClose={() => setOffer(null)} onDone={() => setOffer(null)} />}
    </>
  );
}
