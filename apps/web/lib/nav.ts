export interface Perm { resource: string; read: boolean; write: boolean; approve: boolean; export: boolean; scope: string }

export interface NavItem { href: string; label: string; icon: string; /** shown when any of these is satisfied */ need?: Array<[string, 'read' | 'write' | 'approve']> }

/** navigation is a convenience only: every endpoint is authorised again on the server */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'pin', need: [['attendance', 'read']] },
  { href: '/leave', label: 'Leave', icon: 'calendar', need: [['leave', 'read']] },
  { href: '/approvals', label: 'Approvals', icon: 'check', need: [['approvals', 'read'], ['leave', 'approve'], ['adjustments', 'approve']] },
  { href: '/employees', label: 'Employees', icon: 'users', need: [['employees', 'read']] },
  { href: '/shifts', label: 'Shifts & rosters', icon: 'layers', need: [['shifts', 'read'], ['rosters', 'read']] },
  { href: '/overtime', label: 'Overtime', icon: 'bolt', need: [['overtime', 'read']] },
  { href: '/timesheets', label: 'Timesheets', icon: 'list', need: [['timesheets', 'read']] },
  { href: '/payroll', label: 'Payroll', icon: 'wallet', need: [['payroll', 'read']] },
  { href: '/payslips', label: 'Payslips', icon: 'file', need: [['payslips', 'read']] },
  { href: '/expenses', label: 'Expenses', icon: 'receipt', need: [['expenses', 'read']] },
  { href: '/loans', label: 'Loans & advances', icon: 'coins', need: [['loans', 'read']] },
  { href: '/compliance', label: 'Compliance', icon: 'shield', need: [['compliance', 'read']] },
  { href: '/reports', label: 'Reports', icon: 'chart', need: [['reports', 'read']] },
  { href: '/audit', label: 'Audit', icon: 'eye', need: [['audit', 'read']] },
  { href: '/settings', label: 'Settings', icon: 'gear' },
];

export function can(perms: Perm[], resource: string, action: 'read' | 'write' | 'approve' | 'export'): boolean {
  return perms.some((p) => p.resource === resource && p[action]);
}

export function visibleNav(perms: Perm[]): NavItem[] {
  return NAV.filter((n) => !n.need || n.need.some(([r, a]) => can(perms, r, a)));
}
