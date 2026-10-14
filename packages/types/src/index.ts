export const COMPANY_NAME = 'NUTEX';

export const ROLES = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'FINANCE_PAYROLL', 'EMPLOYEE', 'ATTENDANCE_OPERATOR'] as const;
export type Role = (typeof ROLES)[number];

export type Action = 'read' | 'write' | 'approve' | 'export';

/** Resources map to API modules (not 1:1 to tabs). */
export const RESOURCES = [
  'employees', 'attendance', 'attendance_events', 'adjustments', 'shifts', 'rosters', 'holidays',
  'leave', 'leave_balances', 'overtime', 'timesheets', 'payroll', 'payslips', 'salary', 'expenses', 'loans',
  'compliance', 'reports', 'approvals', 'audit', 'settings', 'users', 'notifications', 'documents', 'tax',
] as const;
export type Resource = (typeof RESOURCES)[number];

export type Scope = 'ALL' | 'BRANCH' | 'TEAM' | 'SELF';

export interface PermissionRow { role: Role; resource: Resource; actions: Action[]; scope: Scope }

const P = (role: Role, resource: Resource, actions: Action[], scope: Scope): PermissionRow => ({ role, resource, actions, scope });
const RW: Action[] = ['read', 'write'];
const RWAE: Action[] = ['read', 'write', 'approve', 'export'];

const SELF_RESOURCES: Resource[] = [
  'attendance', 'attendance_events', 'adjustments', 'leave', 'leave_balances', 'overtime', 'timesheets', 'payslips', 'salary', 'expenses', 'loans', 'tax', 'documents', 'notifications', 'employees',
];
// a person may see their own check-in locations and their own salary structure, but never write them
// (punches go through the location-verified endpoint; salary is set by the owner / finance)
const SELF_READ_ONLY = new Set<Resource>(['payslips', 'salary', 'leave_balances', 'employees', 'attendance_events']);

/**
 * Default permission matrix. It is seeded into the ROLES tab; the API enforces whatever the ROLES tab says
 * (deny by default). SUPER_ADMIN holds every action on every resource with company-wide scope.
 */
export const DEFAULT_PERMISSIONS: PermissionRow[] = [
  ...RESOURCES.map((r) => P('SUPER_ADMIN', r, RWAE, 'ALL')),

  P('HR_ADMIN', 'employees', RWAE, 'BRANCH'), P('HR_ADMIN', 'attendance', RWAE, 'BRANCH'), P('HR_ADMIN', 'attendance_events', ['read', 'export'], 'BRANCH'),
  P('HR_ADMIN', 'adjustments', RWAE, 'BRANCH'), P('HR_ADMIN', 'shifts', RW, 'BRANCH'), P('HR_ADMIN', 'rosters', RW, 'BRANCH'),
  P('HR_ADMIN', 'holidays', RW, 'BRANCH'), P('HR_ADMIN', 'leave', RWAE, 'BRANCH'), P('HR_ADMIN', 'leave_balances', RW, 'BRANCH'),
  P('HR_ADMIN', 'overtime', RWAE, 'BRANCH'), P('HR_ADMIN', 'timesheets', RWAE, 'BRANCH'), P('HR_ADMIN', 'expenses', RWAE, 'BRANCH'),
  P('HR_ADMIN', 'loans', RW, 'BRANCH'), P('HR_ADMIN', 'reports', ['read', 'export'], 'BRANCH'), P('HR_ADMIN', 'approvals', ['read', 'approve'], 'BRANCH'),
  P('HR_ADMIN', 'payroll', ['read', 'write'], 'BRANCH'), P('HR_ADMIN', 'notifications', ['read'], 'BRANCH'), P('HR_ADMIN', 'documents', RW, 'BRANCH'),
  P('HR_ADMIN', 'compliance', ['read'], 'BRANCH'), P('HR_ADMIN', 'audit', ['read'], 'BRANCH'),
  // HR gives the people of their own branch a username and password (ordinary roles only; enforced in admin/admin.ts)
  P('HR_ADMIN', 'users', RW, 'BRANCH'),

  P('MANAGER', 'employees', ['read'], 'TEAM'), P('MANAGER', 'attendance', ['read'], 'TEAM'), P('MANAGER', 'adjustments', ['read', 'approve'], 'TEAM'),
  P('MANAGER', 'leave', ['read', 'approve'], 'TEAM'), P('MANAGER', 'overtime', ['read', 'approve'], 'TEAM'), P('MANAGER', 'timesheets', ['read', 'approve'], 'TEAM'),
  P('MANAGER', 'expenses', ['read', 'approve'], 'TEAM'), P('MANAGER', 'reports', ['read'], 'TEAM'), P('MANAGER', 'approvals', ['read', 'approve'], 'TEAM'),
  P('MANAGER', 'shifts', ['read'], 'TEAM'), P('MANAGER', 'rosters', ['read'], 'TEAM'),
  // managers also act as employees on their own data
  ...SELF_RESOURCES.map((r) => P('MANAGER', r, SELF_READ_ONLY.has(r) ? ['read'] : RW, 'SELF')),

  P('FINANCE_PAYROLL', 'employees', ['read'], 'ALL'), P('FINANCE_PAYROLL', 'attendance', ['read'], 'ALL'), P('FINANCE_PAYROLL', 'payroll', RWAE, 'ALL'),
  P('FINANCE_PAYROLL', 'payslips', RWAE, 'ALL'), P('FINANCE_PAYROLL', 'salary', RWAE, 'ALL'), P('FINANCE_PAYROLL', 'expenses', RWAE, 'ALL'),
  P('FINANCE_PAYROLL', 'loans', RWAE, 'ALL'), P('FINANCE_PAYROLL', 'compliance', RWAE, 'ALL'), P('FINANCE_PAYROLL', 'reports', ['read', 'export'], 'ALL'),
  P('FINANCE_PAYROLL', 'tax', RW, 'ALL'), P('FINANCE_PAYROLL', 'approvals', ['read', 'approve'], 'ALL'), P('FINANCE_PAYROLL', 'audit', ['read'], 'ALL'),
  P('FINANCE_PAYROLL', 'overtime', ['read'], 'ALL'), P('FINANCE_PAYROLL', 'leave', ['read'], 'ALL'),

  ...SELF_RESOURCES.map((r) => P('EMPLOYEE', r, SELF_READ_ONLY.has(r) ? ['read'] : RW, 'SELF')),

  P('ATTENDANCE_OPERATOR', 'attendance', ['read'], 'BRANCH'), P('ATTENDANCE_OPERATOR', 'attendance_events', ['read'], 'BRANCH'),
  P('ATTENDANCE_OPERATOR', 'adjustments', RW, 'BRANCH'), P('ATTENDANCE_OPERATOR', 'employees', ['read'], 'BRANCH'),
];

export interface SessionUser {
  userId: string;
  employeeId: string;
  email: string;
  role: Role;
  companyId: string;
  /** location ids this user may act on; ['ALL'] = every branch */
  locationScope: string[];
  /** the administrator issued this password: the person must choose their own before doing anything else */
  mustChangePassword?: boolean;
}

export type PayrollStatus = 'OPEN' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'LOCKED';
export const PAYROLL_TRANSITIONS: Record<PayrollStatus, PayrollStatus[]> = {
  OPEN: ['PROCESSING'],
  PROCESSING: ['REVIEW', 'OPEN'],
  REVIEW: ['APPROVED', 'PROCESSING'],
  APPROVED: ['LOCKED', 'REVIEW'],
  LOCKED: [],
};

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type CaptureMethod = 'WEB' | 'MOBILE' | 'MANUAL' | 'IMPORT';
/** result of comparing a punch location with the branch geofence */
export type GeoStatus = 'INSIDE' | 'OUTSIDE' | 'UNKNOWN' | 'NOT_REQUIRED';

export interface ApiErrorBody { error: { code: string; message: string; requestId: string } }
