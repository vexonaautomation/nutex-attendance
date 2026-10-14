import { DEFAULT_PERMISSIONS } from '@nutex/types';

export interface ConfigRow { key: string; value: string | number; type: string; description: string }

/** SYSTEM_CONFIG defaults. Formulas read these through $CFG(KEY). */
export const SYSTEM_CONFIG_DEFAULTS: ConfigRow[] = [
  { key: 'COMPANY_NAME', value: 'NUTEX', type: 'text', description: 'Company display name' },
  { key: 'COMPANY_ID', value: 'CMP-NUTEX', type: 'text', description: 'Tenant / company id written to every record' },
  { key: 'SCHEMA_VERSION', value: '2.0.0', type: 'text', description: 'Workbook schema version; verify script compares it' },
  { key: 'TIMEZONE_DEFAULT', value: 'Asia/Kolkata', type: 'text', description: 'Fallback IANA timezone when a location has none' },
  { key: 'DAY_BOUNDARY_HOURS', value: 4, type: 'number', description: 'Hours after midnight at which a new work date starts for IN punches' },
  { key: 'MAX_SEGMENT_HOURS', value: 20, type: 'number', description: 'Longest IN->OUT gap treated as one work segment (longer = missing punch)' },
  { key: 'DUPLICATE_WINDOW_SEC', value: 120, type: 'number', description: 'Same-type punches inside this window are duplicates' },
  { key: 'NIGHT_START_HOUR', value: 22, type: 'number', description: 'Night window start (hour of day)' },
  { key: 'NIGHT_END_HOUR', value: 6, type: 'number', description: 'Night window end (hour of day)' },
  { key: 'OT_HOURS_PER_DAY', value: 8, type: 'number', description: 'Hours per day used for the hourly OT base' },
  { key: 'LEAVE_YEAR_START_MONTH', value: 1, type: 'number', description: 'First month of the leave year (1 = January)' },
  { key: 'ACCRUAL_AS_OF_DATE', value: '2026-09-30', type: 'date', description: 'Accrual is calculated up to this date (set by the accrual job, never TODAY())' },
  { key: 'ATTENDANCE_AS_OF', value: '2026-09-29T12:00:00', type: 'datetime', description: 'Local date-time the attendance formulas treat as now. Set by the API on every punch and at least every few minutes; never TODAY(), so history stays reproducible' },
  { key: 'DASHBOARD_DATE', value: '2026-09-29', type: 'date', description: 'Date the dashboard attendance metrics report on' },
  { key: 'ACTIVE_PERIOD_ID', value: 'PR-2026-09', type: 'text', description: 'Payroll period shown on the dashboard' },
  { key: 'PERIOD_LOCK_ENFORCE', value: 'Y', type: 'yn', description: 'API refuses changes that fall into LOCKED periods' },
  { key: 'PARTITION_STRATEGY', value: 'NONE', type: 'text', description: 'NONE | MONTHLY. MONTHLY = archive closed months to a per-year archive workbook (see docs)' },
  { key: 'CAPACITY_WARN_PCT', value: 0.8, type: 'percent', description: 'Dashboard warns when a tab reaches this share of formula capacity' },
  { key: 'DRIVE_ROOT_FOLDER_ID', value: '', type: 'text', description: 'Set by google:create' },
  { key: 'DRIVE_DOCS_FOLDER_ID', value: '', type: 'text', description: 'Employee documents folder (restricted)' },
  { key: 'DRIVE_PAYSLIP_FOLDER_ID', value: '', type: 'text', description: 'Generated payslip PDFs folder (restricted)' },
  { key: 'PUNCH_REQUIRES_LOCATION', value: 'Y', type: 'yn', description: 'Y = every check-in / check-out must carry a fresh GPS fix (latitude, longitude, accuracy), which is stored on the attendance event. N = location is recorded when the device shares it but is not mandatory' },
  { key: 'LOCATION_MAX_ACCURACY_M', value: 150, type: 'number', description: 'A GPS fix less accurate than this many metres is rejected, and the employee is asked to retry with precise location on' },
  { key: 'LOCATION_MAX_AGE_SEC', value: 300, type: 'number', description: 'A GPS fix captured longer ago than this (device clock vs server clock) is rejected as stale' },
  { key: 'FEATURE_TIMESHEETS', value: 'Y', type: 'yn', description: 'Enable timesheets module' },
];

export interface RuleSeed { code: string; description: string; value: number; unit: string }
/** ILLUSTRATIVE demo values only. Verify against current law / your state before production use. */
export const STATUTORY_RULE_SEEDS: RuleSeed[] = [
  { code: 'PF_EMP_RATE', description: 'Employee PF contribution rate', value: 0.12, unit: 'rate' },
  { code: 'PF_ER_RATE', description: 'Employer PF contribution rate (EPF + EPS + admin, simplified)', value: 0.12, unit: 'rate' },
  { code: 'PF_WAGE_CEILING', description: 'PF wage ceiling per month', value: 15000, unit: 'INR' },
  { code: 'PF_CEILING_ENABLED', description: '1 = cap PF wage at the ceiling, 0 = uncapped', value: 1, unit: 'flag' },
  { code: 'ESI_EMP_RATE', description: 'Employee ESI rate', value: 0.0075, unit: 'rate' },
  { code: 'ESI_ER_RATE', description: 'Employer ESI rate', value: 0.0325, unit: 'rate' },
  { code: 'ESI_GROSS_CEILING', description: 'ESI eligibility: monthly contract gross ceiling', value: 21000, unit: 'INR' },
  { code: 'PT_SLAB1_FROM', description: 'Professional tax slab 1 starts at gross', value: 15000, unit: 'INR' },
  { code: 'PT_SLAB1_AMOUNT', description: 'Professional tax slab 1 amount', value: 150, unit: 'INR' },
  { code: 'PT_SLAB2_FROM', description: 'Professional tax slab 2 starts at gross', value: 25000, unit: 'INR' },
  { code: 'PT_SLAB2_AMOUNT', description: 'Professional tax slab 2 amount', value: 200, unit: 'INR' },
  { code: 'LWF_APPLY_MONTH', description: 'Month number in which LWF is deducted (0 = never)', value: 12, unit: 'month' },
  { code: 'LWF_EMP', description: 'Employee LWF amount', value: 10, unit: 'INR' },
  { code: 'LWF_ER', description: 'Employer LWF amount', value: 20, unit: 'INR' },
  { code: 'TDS_FLAT_RATE', description: 'Optional flat TDS rate on taxable earnings (0 = finance enters TDS manually)', value: 0, unit: 'rate' },
  { code: 'TDS_MIN_MONTHLY_TAXABLE', description: 'Flat TDS applies from this monthly taxable amount', value: 0, unit: 'INR' },
  { code: 'OT_MULT_REGULAR', description: 'OT multiplier on regular days', value: 2, unit: 'x' },
  { code: 'OT_MULT_OFFDAY', description: 'OT multiplier on holidays / weekly offs', value: 2, unit: 'x' },
  { code: 'OT_NIGHT_EXTRA', description: 'Extra multiplier added for night OT minutes', value: 0.25, unit: 'x' },
  { code: 'LEAVE_ENCASH_DIVISOR', description: 'Divisor for daily rate in leave encashment', value: 26, unit: 'days' },
  { code: 'NOTICE_RECOVERY_DIVISOR', description: 'Divisor for daily rate in notice recovery', value: 30, unit: 'days' },
  { code: 'GRATUITY_MIN_YEARS', description: 'Minimum service years for gratuity', value: 5, unit: 'years' },
  { code: 'GRATUITY_DAYS', description: 'Gratuity days per completed year', value: 15, unit: 'days' },
  { code: 'GRATUITY_DIVISOR', description: 'Gratuity monthly divisor', value: 26, unit: 'days' },
  { code: 'GRATUITY_CAP', description: 'Gratuity ceiling', value: 2000000, unit: 'INR' },
];

export const ROLE_ROWS = DEFAULT_PERMISSIONS.map((p, i) => ({
  role_id: `ROLE-${String(i + 1).padStart(4, '0')}`,
  role: p.role,
  resource: p.resource,
  can_read: p.actions.includes('read') ? 'Y' : 'N',
  can_write: p.actions.includes('write') ? 'Y' : 'N',
  can_approve: p.actions.includes('approve') ? 'Y' : 'N',
  can_export: p.actions.includes('export') ? 'Y' : 'N',
  scope: p.scope,
  description: `${p.role} on ${p.resource}`,
}));

export const COMPONENT_SEEDS = [
  { code: 'BASIC', name: 'Basic', type: 'EARNING', taxable: 'Y', pf: 'Y', esi: 'Y', ot: 'Y' },
  { code: 'HRA', name: 'House Rent Allowance', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'Y', ot: 'N' },
  { code: 'DA', name: 'Dearness Allowance', type: 'EARNING', taxable: 'Y', pf: 'Y', esi: 'Y', ot: 'Y' },
  { code: 'CONVEYANCE', name: 'Conveyance', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'Y', ot: 'N' },
  { code: 'SPECIAL', name: 'Special Allowance', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'Y', ot: 'N' },
  { code: 'OTHER', name: 'Other Allowance', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'Y', ot: 'N' },
  { code: 'CUSTOM1', name: 'Custom Earning 1', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'N', ot: 'N' },
  { code: 'CUSTOM2', name: 'Custom Earning 2', type: 'EARNING', taxable: 'Y', pf: 'N', esi: 'N', ot: 'N' },
];
