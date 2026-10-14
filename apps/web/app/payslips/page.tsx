'use client';
import { DataTable } from '@/components/DataTable';
import { Card, ErrorState, PageHeader } from '@/components/ui';
import { useFetch } from '@/hooks/useApi';
import { inr } from '@/lib/format';

type Row = Record<string, unknown>;

export default function PayslipsPage() {
  const slips = useFetch<Row[]>('/api/payslips');
  return (
    <>
      <PageHeader title="Payslips" subtitle="Generated from the locked payroll snapshot. Each download is integrity-checked and audited." />
      <Card>
        {slips.error ? <ErrorState error={slips.error} onRetry={slips.reload} /> : (
          <DataTable<Row> rows={slips.data} loading={slips.loading} exportName="payslips" empty={{ title: 'No payslips yet', hint: 'A payslip appears once the payroll period is locked and payslips are generated.' }}
            columns={[{ key: 'periodId', label: 'Period' }, { key: 'employeeId', label: 'Employee' }, { key: 'netPay', label: 'Net pay', align: 'num', render: (r) => inr(r.netPay), value: (r) => Number(r.netPay) }, { key: 'generatedAt', label: 'Generated', render: (r) => String(r.generatedAt ?? '').slice(0, 10) },
              { key: '_d', label: '', sortable: false, render: (r) => <a className="btn sm primary" href={`/api/payslips/${encodeURIComponent(String(r.payslipId))}/pdf`}>Download PDF</a> }]} />
        )}
      </Card>
    </>
  );
}
