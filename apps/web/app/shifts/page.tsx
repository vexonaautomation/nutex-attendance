'use client';
import { useState } from 'react';
import { PageHeader, Tabs } from '@/components/ui';
import { ResourcePage } from '@/components/ResourcePage';

const TABS = [{ id: 'shifts', label: 'Shifts' }, { id: 'rosters', label: 'Rosters' }, { id: 'holidays', label: 'Holidays' }];

export default function ShiftsPage() {
  const [tab, setTab] = useState('shifts');
  return (
    <>
      <PageHeader title="Shifts & rosters" subtitle="Fixed, night, flexible and split shifts. A roster row overrides the employee's default shift and weekly off for that date." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'shifts' && <ResourcePage path="shifts" createLabel="Add shift" columns={['shift_id', 'shift_name', 'shift_type', 'start_time', 'end_time', 'break_minutes', 'grace_in_minutes', 'full_day_minutes', 'half_day_minutes', 'is_flexible']} description="End time earlier than start time means the shift crosses midnight." />}
      {tab === 'rosters' && <ResourcePage path="rosters" createLabel="Assign shift" columns={['employee_id', 'work_date', 'shift_id', 'is_week_off', 'status']} />}
      {tab === 'holidays' && <ResourcePage path="holidays" createLabel="Add holiday" columns={['holiday_date', 'name', 'holiday_type', 'location_id', 'status']} description="location_id = ALL applies company wide." />}
    </>
  );
}
