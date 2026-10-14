'use client';
import { PageHeader, Badge } from '@/components/ui';
import { WorkflowPage } from '@/components/WorkflowPage';
import { useAuth } from '@/components/AuthProvider';
import { inr } from '@/lib/format';

export default function ExpensesPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Expenses" subtitle="An approved claim becomes a reimbursement input for the next open payroll period." />
      <WorkflowPage
        title="Expense claims" exportName="expenses" listUrl="/api/expenses" idKey="expense_id" canCreate={can('expenses', 'write')} canDecide={can('expenses', 'approve')}
        createUrl="/api/expenses" createLabel="New claim"
        createFields={[{ name: 'expenseDate', label: 'Date', type: 'date', required: true }, { name: 'category', label: 'Category', type: 'select', options: ['Travel', 'Meals', 'Accommodation', 'Client', 'Office', 'Other'], required: true }, { name: 'amount', label: 'Amount (INR)', type: 'number', required: true }, { name: 'description', label: 'Description', type: 'textarea' }]}
        buildBody={(v) => ({ expenseDate: v.expenseDate, category: v.category, amount: Number(v.amount), description: v.description ?? '' })}
        decisionUrl={(id) => `/api/expenses/${id}/decision`}
        columns={[{ key: 'employee_id', label: 'Employee' }, { key: 'expense_date', label: 'Date' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', align: 'num', render: (r) => inr(r.amount), value: (r) => Number(r.amount) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]}
      />
    </>
  );
}
