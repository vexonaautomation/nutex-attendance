'use client';
import { useRef, useState } from 'react';
import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { PunchLog } from '@/components/PunchLog';
import { SalaryPanel } from '@/components/SalaryPanel';
import { EmployeeLogin } from '@/components/UserAdmin';
import { Badge, Card, ErrorState, Loading, PageHeader, Tabs, useToast } from '@/components/ui';
import { useAction, useFetch } from '@/hooks/useApi';
import { dateOnly, inr, isoDay, minutesToHm, monthRange, timeOnly } from '@/lib/format';

type Row = Record<string, unknown>;

function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
}

function EmployeeProfileInner() {
  const { id } = useParams<{ id: string }>();
  const wanted = useSearchParams().get('tab');
  const empId = decodeURIComponent(id);
  const { can } = useAuth();
  const [tab, setTab] = useState(wanted && ['attendance', 'leave', 'documents', 'locations', 'payslips', 'salary', 'login'].includes(wanted) ? wanted : 'overview');
  const emp = useFetch<Row>(`/api/r/employees/${encodeURIComponent(empId)}`);
  const ym = isoDay().slice(0, 7);
  const { from, to } = monthRange(ym);
  const att = useFetch<Row[]>(tab === 'attendance' ? `/api/attendance/daily?from=${from}&to=${to}&employeeId=${encodeURIComponent(empId)}` : null);
  const bal = useFetch<Row[]>(tab === 'leave' ? `/api/leave/balances?employeeId=${encodeURIComponent(empId)}` : null);
  const docs = useFetch<Row[]>(tab === 'documents' ? `/api/documents?employeeId=${encodeURIComponent(empId)}` : null);
  const slips = useFetch<Row[]>(tab === 'payslips' ? '/api/payslips' : null);
  const { busy, run } = useAction();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState('ID proof');

  if (emp.error) return <ErrorState error={emp.error} onRetry={emp.reload} />;
  if (!emp.data) return <Loading rows={5} />;
  const e = emp.data;
  const tabs = [
    { id: 'overview', label: 'Overview' }, { id: 'attendance', label: 'Attendance' }, { id: 'leave', label: 'Leave' }, { id: 'documents', label: 'Documents' },
    ...(can('attendance_events') ? [{ id: 'locations', label: 'Check-in locations' }] : []),
    ...(can('payslips') ? [{ id: 'payslips', label: 'Payslips' }] : []), ...(can('salary') ? [{ id: 'salary', label: 'Salary' }] : []),
    ...(can('users', 'write') ? [{ id: 'login', label: 'Login & password' }] : []),
  ];

  async function upload(f: File) {
    if (f.size > 5_000_000) { toast.push({ kind: 'bad', text: 'File is larger than 5 MB' }); return; }
    const dataBase64 = await fileToBase64(f);
    const r = await run(() => api.post('/api/documents', { employeeId: empId, docType, fileName: f.name, mimeType: f.type, dataBase64 }), 'Uploaded');
    if (r) docs.reload();
  }

  return (
    <>
      <PageHeader title={`${String(e.first_name)} ${String(e.last_name ?? '')}`} subtitle={`${String(e.employee_code)} · ${String(e.employment_type ?? '')} · joined ${dateOnly(e.date_of_joining)}`} actions={<Badge value={e.employee_status ?? e.status} />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && (
        <Card title="Details">
          <div className="grid cols-3">
            {['email', 'phone', 'department_id', 'designation_id', 'location_id', 'manager_employee_id', 'default_shift_id', 'weekly_off_pattern', 'probation_end_date', 'ot_eligible', 'pf_applicable', 'esi_applicable', 'pt_applicable', 'date_of_exit'].map((k) => (
              <div key={k} className="kpi"><span className="l">{k.replace(/_/g, ' ')}</span><span>{String(e[k] ?? '') || '-'}</span></div>
            ))}
          </div>
        </Card>
      )}
      {tab === 'attendance' && (
        <Card title={`Attendance ${ym}`}>
          {att.error ? <ErrorState error={att.error} onRetry={att.reload} /> : (
            <DataTable<Row> exportName={`attendance-${empId}-${ym}`} rows={att.data} loading={att.loading} pageSize={31}
              columns={[{ key: 'work_date', label: 'Date' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'first_in', label: 'In', render: (r) => timeOnly(r.first_in) }, { key: 'last_out', label: 'Out', render: (r) => timeOnly(r.last_out) },
                { key: 'worked_minutes', label: 'Worked', render: (r) => minutesToHm(r.worked_minutes), align: 'num' }, { key: 'late_minutes', label: 'Late (m)', align: 'num' }, { key: 'day_credit', label: 'Credit', align: 'num' }]} />
          )}
        </Card>
      )}
      {tab === 'leave' && (
        <Card title="Leave balances">
          {bal.error ? <ErrorState error={bal.error} onRetry={bal.reload} /> : (
            <DataTable<Row> exportName={`leave-${empId}`} rows={bal.data} loading={bal.loading} searchable={false}
              columns={[{ key: 'leave_type_id', label: 'Type' }, { key: 'leave_year', label: 'Year' }, { key: 'credited', label: 'Credited', align: 'num' }, { key: 'debited', label: 'Taken', align: 'num' }, { key: 'balance', label: 'Balance', align: 'num' }, { key: 'pending_approval', label: 'Pending', align: 'num' }, { key: 'available', label: 'Available', align: 'num' }]} />
          )}
        </Card>
      )}
      {tab === 'documents' && (
        <Card title="Documents" actions={can('documents', 'write') && (
          <span className="row">
            <select aria-label="Document type" value={docType} onChange={(ev) => setDocType(ev.target.value)} style={{ width: 160 }}>{['ID proof', 'Address proof', 'Offer letter', 'Contract', 'Certificate', 'Other'].map((t) => <option key={t}>{t}</option>)}</select>
            <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(ev) => { const f = ev.target.files?.[0]; if (f) void upload(f); ev.target.value = ''; }} />
            <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : 'Upload'}</button>
          </span>)}>
          <p className="muted" style={{ marginBottom: 10 }}>PDF, JPEG or PNG up to 5 MB. Files are stored in a restricted Drive folder; only the id and checksum are kept in the workbook.</p>
          {docs.error ? <ErrorState error={docs.error} onRetry={docs.reload} /> : (
            <DataTable<Row> rows={docs.data} loading={docs.loading} exportName={`documents-${empId}`}
              columns={[{ key: 'docType', label: 'Type' }, { key: 'fileName', label: 'File' }, { key: 'size', label: 'Size', align: 'num' }, { key: 'uploadedAt', label: 'Uploaded', render: (r) => dateOnly(r.uploadedAt) },
                { key: '_d', label: '', sortable: false, render: (r) => <a className="btn sm" href={`/api/documents/${encodeURIComponent(String(r.documentId))}/download`}>Download</a> }]} />
          )}
        </Card>
      )}
      {tab === 'payslips' && (
        <Card title="Payslips">
          <DataTable<Row> rows={(slips.data ?? []).filter((s) => s.employeeId === empId)} loading={slips.loading} exportName={`payslips-${empId}`} searchable={false}
            columns={[{ key: 'periodId', label: 'Period' }, { key: 'netPay', label: 'Net pay', render: (r) => inr(r.netPay), align: 'num' }, { key: '_d', label: '', sortable: false, render: (r) => <a className="btn sm" href={`/api/payslips/${encodeURIComponent(String(r.payslipId))}/pdf`}>PDF</a> }]} />
        </Card>
      )}
      {tab === 'salary' && <SalaryPanel employeeId={empId} canWrite={can('salary', 'write')} />}
      {tab === 'locations' && (
        <Card title={`Check-in locations ${ym}`}>
          <PunchLog from={from} to={to} employeeId={empId} showEmployee={false} exportName={`punch-locations-${empId}-${ym}`} />
        </Card>
      )}
      {tab === 'login' && (
        <EmployeeLogin employee={{ employee_id: empId, employee_code: String(e.employee_code), first_name: String(e.first_name), last_name: String(e.last_name ?? ''), location_id: String(e.location_id ?? ''), status: String(e.status ?? '') }} />
      )}
    </>
  );
}

export default function EmployeeProfile() {
  return <Suspense fallback={null}><EmployeeProfileInner /></Suspense>;
}
