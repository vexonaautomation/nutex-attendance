'use client';
import { PageHeader, Badge } from '@/components/ui';
import { WorkflowPage } from '@/components/WorkflowPage';
import { useAuth } from '@/components/AuthProvider';
import { inr } from '@/lib/format';

export default function LoansPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Loans & advances" subtitle="EMI is calculated in the sheet (PMT). Installments are recovered through payroll and marked deducted when the period is locked." />
      <WorkflowPage
        title="Loan book" exportName="loans" listUrl="/api/loans" idKey="loan_id" canCreate={can('loans', 'approve')} canDecide={false}
        createUrl="/api/loans" createLabel="New loan / advance"
        createFields={[{ name: 'employeeId', label: 'Employee id', type: 'text', required: true }, { name: 'loanType', label: 'Type', type: 'select', options: ['LOAN', 'ADVANCE'], default: 'LOAN', required: true }, { name: 'principal', label: 'Principal (INR)', type: 'number', required: true },
          { name: 'annualInterestRate', label: 'Annual interest (0.09 = 9%)', type: 'number', default: '0' }, { name: 'tenureMonths', label: 'Tenure (months)', type: 'number', required: true }, { name: 'startPeriodId', label: 'First recovery period', type: 'text', required: true, default: 'PR-2026-10', hint: 'PR-YYYY-MM' }, { name: 'purpose', label: 'Purpose', type: 'text' }]}
        buildBody={(v) => ({ employeeId: v.employeeId, loanType: v.loanType || 'LOAN', principal: Number(v.principal), annualInterestRate: Number(v.annualInterestRate || 0), tenureMonths: Math.round(Number(v.tenureMonths)), startPeriodId: v.startPeriodId, purpose: v.purpose ?? '' })}
        columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'loan_type', label: 'Type' }, { key: 'principal', label: 'Principal', align: 'num', render: (r) => inr(r.principal), value: (r) => Number(r.principal) }, { key: 'tenure_months', label: 'Months', align: 'num' }, { key: 'emi', label: 'EMI', align: 'num', render: (r) => inr(r.emi), value: (r) => Number(r.emi) },
          { key: 'recovered', label: 'Recovered', align: 'num', render: (r) => inr(r.recovered), value: (r) => Number(r.recovered) }, { key: 'outstanding', label: 'Outstanding', align: 'num', render: (r) => inr(r.outstanding), value: (r) => Number(r.outstanding) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]}
      />
    </>
  );
}
