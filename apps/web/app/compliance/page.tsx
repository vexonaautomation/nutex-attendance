'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Tabs, Card } from '@/components/ui';
import { ResourcePage } from '@/components/ResourcePage';
import { useAuth } from '@/components/AuthProvider';

export default function CompliancePage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('rules');
  return (
    <>
      <PageHeader title="Compliance" subtitle="PF, ESI, professional tax, LWF, TDS, overtime multipliers and gratuity are effective-dated rules read by the payroll formulas." />
      <div className="notice warn"><b>Verify before production.</b> The seeded values are illustrative demo numbers, not legal advice. Confirm each rule against current statute and your state notifications, then add a new version with the correct effective date.</div>
      <Tabs tabs={[{ id: 'rules', label: 'Statutory rules' }, ...(can('salary') ? [{ id: 'components', label: 'Salary components' }] : []), { id: 'reports', label: 'Statutory report' }]} value={tab} onChange={setTab} />
      {tab === 'rules' && <ResourcePage path="statutory-rules" createLabel="New rule version" columns={['rule_code', 'description', 'value', 'unit', 'effective_from', 'effective_to', 'jurisdiction', 'version', 'overlap_check']} />}
      {tab === 'components' && <ResourcePage path="salary-components" createLabel="Add component" columns={['component_code', 'name', 'component_type', 'taxable', 'pf_wage', 'esi_wage', 'ot_base']} description="These flags decide which components count towards PF wage, ESI wage and taxable earnings." />}
      {tab === 'reports' && <Card title="Statutory report"><p>Open <Link href="/reports">Reports</Link> and choose <b>Statutory</b> for PF / ESI / PT / LWF / TDS per employee, or export the PF and ESI files from a payroll period.</p></Card>}
    </>
  );
}
