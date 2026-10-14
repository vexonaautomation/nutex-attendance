'use client';
import { PageHeader, Badge } from '@/components/ui';
import { WorkflowPage } from '@/components/WorkflowPage';
import { useAuth } from '@/components/AuthProvider';

export default function TimesheetsPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Timesheets" subtitle="Project time, reconciled by formula against the attendance hours of the same day." />
      <WorkflowPage
        title="Timesheet entries" exportName="timesheets" listUrl="/api/timesheets" idKey="timesheet_id" canCreate={can('timesheets', 'write')} canDecide={can('timesheets', 'approve')}
        createUrl="/api/timesheets" createLabel="Add entry"
        createFields={[{ name: 'workDate', label: 'Date', type: 'date', required: true }, { name: 'projectCode', label: 'Project code', type: 'text', required: true }, { name: 'hours', label: 'Hours', type: 'number', required: true }, { name: 'task', label: 'Task', type: 'text' }, { name: 'billable', label: 'Billable', type: 'select', options: ['Y', 'N'], default: 'N' }]}
        buildBody={(v) => ({ workDate: v.workDate, projectCode: v.projectCode, hours: Number(v.hours), task: v.task ?? '', billable: v.billable || 'N' })}
        decisionUrl={(id) => `/api/timesheets/${id}/decision`}
        columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'work_date', label: 'Date' }, { key: 'project_code', label: 'Project' }, { key: 'task', label: 'Task' }, { key: 'hours', label: 'Hours', align: 'num' }, { key: 'daily_total_hours', label: 'Day total', align: 'num' },
          { key: 'attendance_hours', label: 'Attendance h', align: 'num' }, { key: 'variance_flag', label: 'Check', render: (r) => <Badge value={r.variance_flag} tone={r.variance_flag === 'OK' ? 'ok' : 'warn'} /> }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]}
      />
    </>
  );
}
