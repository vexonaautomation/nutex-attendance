'use client';
import { PageHeader, Badge } from '@/components/ui';
import { WorkflowPage } from '@/components/WorkflowPage';
import { useAuth } from '@/components/AuthProvider';

export default function OvertimePage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Overtime" subtitle="Payable minutes = the lower of the approved minutes and the OT the attendance formulas calculated. Rates are effective-dated rules, not code." />
      <WorkflowPage
        title="Overtime requests" exportName="overtime" listUrl="/api/overtime" idKey="ot_id" canCreate={can('overtime', 'write')} canDecide={can('overtime', 'approve')} decisionWithMinutes
        createUrl="/api/overtime" createLabel="Request overtime"
        createFields={[{ name: 'workDate', label: 'Work date', type: 'date', required: true }, { name: 'dayType', label: 'Day type', type: 'select', options: ['REGULAR', 'OFFDAY'], default: 'REGULAR', required: true }, { name: 'requestedMinutes', label: 'Minutes', type: 'number', required: true }, { name: 'reason', label: 'Reason', type: 'textarea' }]}
        buildBody={(v) => ({ workDate: v.workDate, dayType: v.dayType, requestedMinutes: Math.round(Number(v.requestedMinutes)), reason: v.reason ?? '' })}
        decisionUrl={(id) => `/api/overtime/${id}/decision`}
        columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'work_date', label: 'Date' }, { key: 'day_type', label: 'Day' }, { key: 'requested_minutes', label: 'Requested', align: 'num' }, { key: 'approved_minutes', label: 'Approved', align: 'num' },
          { key: 'calc_minutes', label: 'Calculated', align: 'num' }, { key: 'payable_minutes', label: 'Payable', align: 'num' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]}
      />
    </>
  );
}
