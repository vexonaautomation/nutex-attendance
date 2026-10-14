import { z } from 'zod';
import { ENUMS, TabDef, inputColumns } from '@nutex/formula-specs';

export * from './password';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/, 'expected YYYY-MM-DDTHH:mm:ss');
const hhmm = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'expected HH:mm');
const safeText = z.string().max(2000).refine((s) => !/^[=+\-@]/.test(s.trim()) || /^[-+]?\d+(\.\d+)?$/.test(s.trim()), 'text must not start with a formula character');

/** zod schema for the INPUT columns of a tab (used by generic CRUD; formula columns can never be submitted) */
export function schemaForTab(tab: TabDef, opts: { omit?: string[]; partial?: boolean; forceOptional?: string[] } = {}) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const c of inputColumns(tab)) {
    if (opts.omit?.includes(c.name)) continue;
    let t: z.ZodTypeAny;
    switch (c.type) {
      case 'date': t = isoDate; break;
      case 'datetime': t = isoDateTime; break;
      case 'time': t = hhmm; break;
      case 'number': case 'money': case 'percent': t = z.coerce.number().finite(); break;
      case 'enum': t = z.enum(ENUMS[c.enum!] as [string, ...string[]]); break;
      case 'yn': t = z.enum(['Y', 'N']); break;
      case 'json': t = z.union([z.string().max(20000), z.record(z.string(), z.any()), z.array(z.any())]); break;
      default: t = safeText;
    }
    shape[c.name] = c.required && !opts.partial && !opts.forceOptional?.includes(c.name) ? t : t.optional().nullable();
  }
  return z.object(shape).strict();
}

/** a device location fix: what the browser Geolocation API returns, plus the moment the fix was taken (ms since epoch) */
export const geoFix = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).optional(),
  capturedAt: z.number().int().positive().optional(),
}).strict();

export const punchBody = z.object({
  type: z.enum(['IN', 'OUT', 'AUTO']).default('AUTO'),
  geo: geoFix.optional(),
  deviceId: z.string().max(80).optional(),
  method: z.enum(['WEB', 'MOBILE']).default('WEB'),
}).strict();

/** an administrator records a punch for someone who could not check in themselves (no location, always with a reason) */
export const manualPunchBody = z.object({
  employeeId: z.string().min(1), type: z.enum(['IN', 'OUT']), at: isoDateTime, reason: z.string().trim().min(5).max(300),
}).strict();

const loginId = z.string().trim().min(3, 'Username must be at least 3 characters').max(80).regex(/^[A-Za-z0-9._@+-]+$/, 'Username may contain letters, digits and . _ @ + - only');

export const createUserBody = z.object({
  employeeId: z.string().min(1), username: loginId, displayName: z.string().trim().min(2).max(80),
  role: z.enum(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'FINANCE_PAYROLL', 'EMPLOYEE', 'ATTENDANCE_OPERATOR']),
  locationScope: z.string().max(200).default(''),
  /** chosen by the administrator; omit to have one generated */
  password: z.string().min(1).max(200).optional(),
  /** true = the person must choose a new password at first sign-in (default) */
  forceChange: z.boolean().default(true),
}).strict();

export const updateUserBody = z.object({
  status: z.enum(['ACTIVE', 'LOCKED', 'DISABLED']).optional(),
  role: z.enum(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'FINANCE_PAYROLL', 'EMPLOYEE', 'ATTENDANCE_OPERATOR']).optional(),
  displayName: z.string().trim().min(2).max(80).optional(),
  locationScope: z.string().max(200).optional(),
  username: loginId.optional(),
  /** generate a new temporary password */
  resetPassword: z.boolean().optional(),
  /** set this exact password */
  password: z.string().min(1).max(200).optional(),
  forceChange: z.boolean().optional(),
}).strict();

export const leaveApplyBody = z.object({
  leaveTypeId: z.string().min(1), fromDate: isoDate, toDate: isoDate, halfDay: z.enum(['Y', 'N']).default('N'), reason: z.string().max(500).default(''),
  employeeId: z.string().optional(),
}).strict();

export const decisionBody = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(500).optional(), approvedMinutes: z.number().min(0).max(1440).optional() }).strict();

export const adjustmentBody = z.object({
  workDate: isoDate, type: z.enum(['MISSING_PUNCH', 'TIME_CORRECTION']), adjustedIn: isoDateTime.optional(), adjustedOut: isoDateTime.optional(), reason: z.string().min(3).max(500),
  employeeId: z.string().optional(),
}).strict().refine((b) => b.adjustedIn || b.adjustedOut, 'adjustedIn or adjustedOut is required');

export const overtimeBody = z.object({ workDate: isoDate, dayType: z.enum(['REGULAR', 'OFFDAY']), requestedMinutes: z.number().int().min(1).max(1440), reason: z.string().max(500).default(''), employeeId: z.string().optional() }).strict();

/** `email` carries the login id: an email address or a plain username such as `admin` */
export const loginBody = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }).strict();

export const payrollTransitionBody = z.object({ to: z.enum(['OPEN', 'PROCESSING', 'REVIEW', 'APPROVED', 'LOCKED']), note: z.string().max(500).optional() }).strict();

export const payrollInputPatch = z.object({
  bonus: z.number().optional(), incentive: z.number().optional(), arrears: z.number().optional(), manual_adjustment: z.number().optional(),
  manual_adjustment_reason: z.string().max(300).optional(), other_deduction: z.number().min(0).optional(), tds_manual_flag: z.enum(['Y', 'N']).optional(),
  tds_manual_amount: z.number().min(0).optional(), remarks: z.string().max(300).optional(),
}).strict();

export const loanBody = z.object({
  employeeId: z.string().min(1), loanType: z.enum(['LOAN', 'ADVANCE']), principal: z.number().positive(), annualInterestRate: z.number().min(0).max(1).default(0),
  tenureMonths: z.number().int().min(1).max(120), startPeriodId: z.string().regex(/^PR-\d{4}-\d{2}$/), purpose: z.string().max(300).default(''),
}).strict();

export const expenseBody = z.object({
  expenseDate: isoDate, category: z.string().max(60), description: z.string().max(500).default(''), amount: z.number().positive().max(10_000_000), employeeId: z.string().optional(),
}).strict();

export const timesheetBody = z.object({ workDate: isoDate, projectCode: z.string().min(1).max(40), task: z.string().max(200).default(''), hours: z.number().min(0.25).max(24), billable: z.enum(['Y', 'N']).default('N'), employeeId: z.string().optional() }).strict();

export const taxDeclarationBody = z.object({
  financialYear: z.string().regex(/^\d{4}-\d{2}$/), regime: z.enum(['NEW', 'OLD']), section: z.string().max(20), description: z.string().max(200).default(''), declaredAmount: z.number().min(0).max(100_000_000),
}).strict();

export type PunchBody = z.infer<typeof punchBody>;
export type ManualPunchBody = z.infer<typeof manualPunchBody>;
export type CreateUserBody = z.infer<typeof createUserBody>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
