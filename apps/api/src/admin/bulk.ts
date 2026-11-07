import ExcelJS from 'exceljs';
import { ENUMS } from '@nutex/formula-specs';
import type { SchemaIndex } from '@nutex/formula-specs';
import { schemaForTab } from '@nutex/validation';
import type { Row } from '@nutex/sheet-connector';
import { Actor, AppContext, auditCols, badRequest, forbidden, str, toLocalWallClock } from '../common/core';
import { SYSTEM_COLS, authorizeCompanyWide } from '../common/resources';
import { scopedEmployeeIds } from '../auth/auth';
import { lockedPeriodFor } from '../common/period';

/**
 * Bulk employees / salaries through an Excel file: download a template (blank, or filled with today's data), edit it, upload it.
 * Every row goes through the same checks as the single forms (required fields, formats, scope, locked periods) and an upload is
 * all or nothing: if one row is wrong, nothing is saved and every problem is listed with its row number.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

type ColType = 'text' | 'date' | 'enum' | 'yn' | 'ref' | 'money';
type RefKind = 'department' | 'designation' | 'location' | 'shift' | 'manager';
interface BulkCol { key: string; header: string; type: ColType; width: number; hint: string; required?: boolean; enumName?: string; ref?: RefKind; info?: boolean }

const EMPLOYEE_COLS: BulkCol[] = [
  { key: 'employee_code', header: 'Employee Code', type: 'text', width: 16, required: true, hint: 'Your own ID for the person, for example E-101. Must be unique. When you upload again, this is how an existing person is found and updated.' },
  { key: 'first_name', header: 'First Name', type: 'text', width: 18, required: true, hint: 'Required for new people.' },
  { key: 'last_name', header: 'Last Name', type: 'text', width: 18, hint: '' },
  { key: 'email', header: 'Email', type: 'text', width: 26, hint: '' },
  { key: 'phone', header: 'Phone', type: 'text', width: 16, hint: 'Digits only is safest (a leading + or = is not accepted).' },
  { key: 'date_of_joining', header: 'Date of Joining', type: 'date', width: 16, required: true, hint: 'dd-mm-yyyy. Required for new people.' },
  { key: 'date_of_exit', header: 'Date of Exit', type: 'date', width: 16, hint: 'dd-mm-yyyy. Leave blank if the person has not left.' },
  { key: 'employment_type', header: 'Employment Type', type: 'enum', enumName: 'EMPLOYMENT_TYPE', width: 18, hint: 'Pick from the list.' },
  { key: 'employee_status', header: 'Employee Status', type: 'enum', enumName: 'EMPLOYEE_STATUS', width: 16, hint: 'Pick from the list. Blank = ACTIVE for new people.' },
  { key: 'department_id', header: 'Department', type: 'ref', ref: 'department', width: 20, hint: 'Pick from the list (names come from Settings).' },
  { key: 'designation_id', header: 'Designation', type: 'ref', ref: 'designation', width: 20, hint: 'Pick from the list.' },
  { key: 'location_id', header: 'Branch', type: 'ref', ref: 'location', width: 20, hint: 'Pick from the list. Decides where the person can check in.' },
  { key: 'manager_employee_id', header: 'Manager Employee Code', type: 'ref', ref: 'manager', width: 22, hint: 'The Employee Code of the manager (can be someone in the same file).' },
  { key: 'default_shift_id', header: 'Default Shift', type: 'ref', ref: 'shift', width: 20, hint: 'Pick from the list.' },
  { key: 'weekly_off_pattern', header: 'Weekly Off', type: 'text', width: 14, hint: 'Day codes: MON,TUE,WED,THU,FRI,SAT,SUN. For example SAT,SUN.' },
  { key: 'probation_end_date', header: 'Probation End Date', type: 'date', width: 18, hint: 'dd-mm-yyyy' },
  { key: 'ot_eligible', header: 'OT Eligible', type: 'yn', width: 12, hint: 'Y or N' },
  { key: 'pf_applicable', header: 'PF Applicable', type: 'yn', width: 13, hint: 'Y or N' },
  { key: 'esi_applicable', header: 'ESI Applicable', type: 'yn', width: 14, hint: 'Y or N' },
  { key: 'pt_applicable', header: 'PT Applicable', type: 'yn', width: 13, hint: 'Y or N' },
  { key: 'cost_center_id', header: 'Cost Center', type: 'text', width: 14, hint: '' },
  { key: 'bank_account_ref', header: 'Bank Account (masked)', type: 'text', width: 20, hint: 'A masked reference only, for example ****1234. Never the full number. Not shown in downloads.' },
  { key: 'bank_ifsc', header: 'Bank IFSC', type: 'text', width: 14, hint: 'Not shown in downloads.' },
];

const MONEY_KEYS = ['basic', 'hra', 'da', 'conveyance', 'special_allowance', 'other_allowance', 'custom_earning_1', 'custom_earning_2'];
const SALARY_COLS: BulkCol[] = [
  { key: 'employee_code', header: 'Employee Code', type: 'text', width: 16, required: true, hint: 'Must match an existing employee.' },
  { key: 'employee_name', header: 'Employee Name (info only)', type: 'text', width: 24, info: true, hint: 'For your reading. Ignored on upload.' },
  { key: 'effective_from', header: 'Effective From', type: 'date', width: 16, required: true, hint: 'dd-mm-yyyy. The new salary starts from this date. A date inside a locked payroll period is refused.' },
  { key: 'basic', header: 'Basic', type: 'money', width: 12, hint: 'Monthly amount in rupees.' },
  { key: 'hra', header: 'HRA', type: 'money', width: 12, hint: '' },
  { key: 'da', header: 'DA', type: 'money', width: 12, hint: '' },
  { key: 'conveyance', header: 'Conveyance', type: 'money', width: 12, hint: '' },
  { key: 'special_allowance', header: 'Special Allowance', type: 'money', width: 16, hint: '' },
  { key: 'other_allowance', header: 'Other Allowance', type: 'money', width: 15, hint: '' },
  { key: 'custom_earning_1', header: 'Custom Earning 1', type: 'money', width: 15, hint: '' },
  { key: 'custom_earning_2', header: 'Custom Earning 2', type: 'money', width: 15, hint: '' },
  { key: 'revision_reason', header: 'Reason', type: 'text', width: 22, hint: 'For example Annual revision. Blank = Bulk update.' },
  { key: 'current_gross', header: 'Current Monthly Gross (info only)', type: 'money', width: 22, info: true, hint: 'For your reading. Ignored on upload.' },
];

export type BulkKind = 'employees' | 'salaries';
export function bulkKind(v: string): BulkKind {
  if (v === 'employees' || v === 'salaries') return v;
  throw badRequest('Unknown bulk type');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const star = (c: BulkCol) => (c.required ? `${c.header} *` : c.header);

// ------------------------------------------------------------------ results

export interface BulkRowResult { row: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'; changes: string[]; errors: string[] }
export interface BulkResult {
  kind: BulkKind; dryRun: boolean; applied: boolean; total: number; created: number; updated: number; unchanged: number; errorCount: number;
  rows: BulkRowResult[]; fileErrors: string[];
}

// ------------------------------------------------------------------ reading cells

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return plain(o.result);
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    if ('text' in o) return plain(o.text);
    if ('error' in o) return `#${String(o.error)}`;
    return String(v);
  }
  return v;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1950 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toIsoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : validDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') return Number.isFinite(v) ? toIsoDate(new Date(Math.round((v - 25569) * 86_400_000))) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}

function toMoney(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  return /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : null;
}

function toEnum(v: unknown, name: string): string | null {
  const t = String(v).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (ENUMS[name] as string[]).includes(t) ? t : null;
}

function toYn(v: unknown): 'Y' | 'N' | null {
  const t = String(v).trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(t)) return 'Y';
  if (['N', 'NO', 'FALSE', '0'].includes(t)) return 'N';
  return null;
}

interface SheetRow { row: number; values: Record<string, unknown> }

/** the first worksheet's rows, keyed by the columns we know (matched by header text, in any order) */
async function readSheet(buf: Buffer, cols: BulkCol[]): Promise<{ rows: SheetRow[]; fileErrors: string[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ExcelJS.Buffer); } catch { throw badRequest('This is not a valid Excel (.xlsx) file. Download the template, fill it in and upload it again.', 'BAD_FILE'); }
  const ws = wb.worksheets.find((w) => w.state !== 'hidden' && !['instructions', 'lists'].includes(w.name.toLowerCase()));
  if (!ws) throw badRequest('The file has no data sheet', 'BAD_FILE');
  const byNorm = new Map(cols.filter((c) => !c.info).map((c) => [norm(c.header), c]));
  const colAt = new Map<number, BulkCol>();
  ws.getRow(1).eachCell((cell, n) => { const c = byNorm.get(norm(String(plain(cell.value) ?? ''))); if (c) colAt.set(n, c); });
  const fileErrors: string[] = [];
  for (const c of cols.filter((x) => x.required)) if (![...colAt.values()].includes(c)) fileErrors.push(`The column "${c.header} *" is missing. Use the downloaded template and keep its first row.`);
  const rows: SheetRow[] = [];
  const last = Math.min(ws.rowCount, MAX_ROWS + 1);
  for (let r = 2; r <= last; r++) {
    const values: Record<string, unknown> = {};
    let any = false;
    const row = ws.getRow(r);
    for (const [n, c] of colAt) { const v = plain(row.getCell(n).value); if (!blank(v)) { values[c.key] = v; any = true; } }
    if (any) rows.push({ row: r, values });
  }
  if (ws.rowCount > MAX_ROWS + 1 && ws.getRow(MAX_ROWS + 2).hasValues) fileErrors.push(`Too many rows: at most ${MAX_ROWS} per upload. Split the file.`);
  if (!rows.length && !fileErrors.length) fileErrors.push('The file has no data rows.');
  return { rows, fileErrors };
}

// ------------------------------------------------------------------ building the template

function styleSheet(ws: ExcelJS.Worksheet, cols: BulkCol[]) {
  const head = ws.getRow(1);
  head.height = 34;
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = star(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    // red = must be filled, blue = optional, grey = information only
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFD9363E' : c.info ? 'FF8C97AD' : 'FF2F6BDE' } };
    if (c.hint) cell.note = c.hint;
    ws.getColumn(i + 1).width = c.width;
  });
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
}

function listRange(lists: ExcelJS.Worksheet, col: number, values: string[]): string | null {
  if (!values.length) return null;
  const letter = lists.getColumn(col).letter;
  values.forEach((v, i) => { lists.getCell(i + 2, col).value = v; });
  return `Lists!$${letter}$2:$${letter}$${values.length + 1}`;
}

function addInstructions(wb: ExcelJS.Workbook, title: string, lines: string[]) {
  const ws = wb.addWorksheet('Instructions');
  ws.getColumn(1).width = 110;
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  lines.forEach((l, i) => { ws.getCell(i + 3, 1).value = l; ws.getCell(i + 3, 1).alignment = { wrapText: true, vertical: 'top' }; });
}

const COMMON_RULES = [
  'RED column titles (with a star) are required. BLUE columns are optional. GREY columns are only for your reading and are ignored.',
  'Do not change the titles in the first row. You may reorder columns or delete optional ones.',
  'Dates: dd-mm-yyyy (for example 15-04-2026). Cells with a drop-down: pick from the list.',
  'Upload is all or nothing: if any row has a problem, nothing is saved and every problem is listed with its row number. Fix the file and upload again.',
  'You can click "Check file" before importing: it shows what will be created or changed without saving anything.',
];

async function lookups(ctx: AppContext) {
  const [departments, designations, locations, shifts, employees] = await Promise.all([
    ctx.repo.readAll('DEPARTMENTS'), ctx.repo.readAll('DESIGNATIONS'), ctx.repo.readAll('LOCATIONS'), ctx.repo.readAll('SHIFT_MASTER'), ctx.repo.readAll('EMPLOYEES'),
  ]);
  const active = (r: Row) => r.status !== 'INACTIVE';
  return {
    departments: departments.filter(active), designations: designations.filter(active), locations: locations.filter(active), shifts: shifts.filter(active), employees,
  };
}

export async function template(ctx: AppContext, actor: Actor, kindRaw: string, withData: boolean): Promise<{ buffer: Buffer; filename: string }> {
  const kind = bulkKind(kindRaw);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NUTEX Attendance';
  const day = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE).slice(0, 10);

  if (kind === 'employees') {
    await authorizeCompanyWide(ctx, actor, 'employees', 'write');
    const L = await lookups(ctx);
    const ws = wb.addWorksheet('Employees');
    styleSheet(ws, EMPLOYEE_COLS);
    addInstructions(wb, 'Employees: bulk add / update', [
      ...COMMON_RULES,
      'New person: put a new Employee Code. The person is created. First Name and Date of Joining are required.',
      'Existing person: keep the same Employee Code and change the cells you want. The person is updated. A blank cell leaves that value as it is (it never clears it).',
      'People who are not in the file are not touched. To remove someone, use Archive in the app.',
      'Department, Designation, Branch and Default Shift are chosen by name from the drop-down (the names must already exist in Settings).',
      'Manager Employee Code is the Employee Code of the manager.',
      'Bank details are never included in a download. If you type them, they are saved (masked reference only).',
    ]);
    const lists = wb.addWorksheet('Lists'); // the drop-down source goes last
    const refValues: Record<RefKind, string[]> = {
      department: L.departments.map((r) => str(r.name)), designation: L.designations.map((r) => str(r.name)), location: L.locations.map((r) => str(r.name)),
      shift: L.shifts.map((r) => str(r.shift_name)), manager: [],
    };
    const ranges: Record<string, string | null> = {};
    let li = 1;
    for (const k of ['department', 'designation', 'location', 'shift'] as RefKind[]) { lists.getCell(1, li).value = k; ranges[k] = listRange(lists, li, refValues[k]); li++; }
    const nameOf = (rows: Row[], key: string, nameKey: string) => new Map(rows.map((r) => [str(r[key]), str(r[nameKey])]));
    const dep = nameOf(L.departments, 'department_id', 'name'); const des = nameOf(L.designations, 'designation_id', 'name');
    const loc = nameOf(L.locations, 'location_id', 'name'); const shf = nameOf(L.shifts, 'shift_id', 'shift_name');
    const codeOf = new Map(L.employees.map((e) => [str(e.employee_id), str(e.employee_code)]));
    if (withData) {
      const ids = await scopedEmployeeIds(ctx, actor.user, 'employees', 'read');
      let r = 2;
      for (const e of L.employees.filter((x) => x.status !== 'INACTIVE' && (ids === 'ALL' || ids.has(str(x.employee_id))))) {
        EMPLOYEE_COLS.forEach((c, i) => {
          if (c.key === 'bank_account_ref' || c.key === 'bank_ifsc') return; // never exported
          let v: unknown = e[c.key];
          if (c.key === 'department_id') v = dep.get(str(v)); else if (c.key === 'designation_id') v = des.get(str(v));
          else if (c.key === 'location_id') v = loc.get(str(v)); else if (c.key === 'default_shift_id') v = shf.get(str(v)); else if (c.key === 'manager_employee_id') v = codeOf.get(str(v));
          if (c.type === 'date') { const iso = toIsoDate(v); v = iso ? new Date(`${iso}T00:00:00.000Z`) : null; }
          if (v !== null && v !== undefined && v !== '') ws.getCell(r, i + 1).value = v as ExcelJS.CellValue;
        });
        r++;
      }
    }
    const lastRow = Math.max(ws.rowCount + 200, 300);
    EMPLOYEE_COLS.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.type === 'date') col.numFmt = 'dd-mm-yyyy';
      if (c.type === 'text') col.numFmt = '@';
      let formula: string | null = null;
      if (c.type === 'enum') formula = `"${(ENUMS[c.enumName!] as string[]).join(',')}"`;
      else if (c.type === 'yn') formula = '"Y,N"';
      else if (c.type === 'ref' && c.ref !== 'manager') formula = ranges[c.ref!];
      if (formula) for (let r = 2; r <= lastRow; r++) ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true, errorTitle: 'Pick from the list', error: 'Choose a value from the drop-down list.' };
    });
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `nutex-employees-${withData ? 'current' : 'blank'}-${day}.xlsx` };
  }

  // salaries
  const ids = await scopedEmployeeIds(ctx, actor.user, 'salary', 'write');
  const ws = wb.addWorksheet('Salaries');
  styleSheet(ws, SALARY_COLS);
  if (withData) {
    const [emps, sal] = await Promise.all([ctx.repo.readAll('EMPLOYEES'), ctx.repo.readAll('EMPLOYEE_SALARY')]);
    let r = 2;
    for (const e of emps.filter((x) => x.status !== 'INACTIVE' && (ids === 'ALL' || ids.has(str(x.employee_id))))) {
      const cur = structureOn(sal, str(e.employee_id), day);
      const name = str(e.full_name) || `${str(e.first_name)} ${str(e.last_name)}`.trim();
      const put = (key: string, v: unknown) => { const i = SALARY_COLS.findIndex((c) => c.key === key); if (v !== null && v !== undefined && v !== '') ws.getCell(r, i + 1).value = v as ExcelJS.CellValue; };
      put('employee_code', str(e.employee_code)); put('employee_name', name);
      if (cur) { for (const k of MONEY_KEYS) put(k, Number(cur[k] ?? 0) || null); put('current_gross', Number(cur.monthly_gross ?? 0) || null); }
      r++;
    }
  }
  SALARY_COLS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'date') col.numFmt = 'dd-mm-yyyy';
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'text') col.numFmt = '@';
  });
  addInstructions(wb, 'Salary: bulk update', [
    ...COMMON_RULES,
    'Each row you fill in Effective From becomes a NEW salary version for that employee, starting from that date. Old rows are never changed (past payroll stays reproducible).',
    'The row is the complete new structure: a blank amount means 0 for that part. The download already shows each person\'s current amounts.',
    'Rows with no Effective From, or whose amounts equal the salary already in force on that date, are skipped as unchanged.',
    'A date inside a locked payroll period is refused: use a later date and post arrears as a payroll input.',
    'Amounts are monthly rupees, numbers only (for example 25000 or 25,000.50).',
  ]);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `nutex-salary-${withData ? 'current' : 'blank'}-${day}.xlsx` };
}

/** the structure in force for an employee on a date: the latest active row that has started */
function structureOn(rows: Row[], employeeId: string, isoDate: string): Row | undefined {
  return rows.filter((r) => str(r.employee_id) === employeeId && r.status !== 'INACTIVE' && str(r.effective_from) && str(r.effective_from) <= isoDate)
    .sort((a, b) => str(b.effective_from).localeCompare(str(a.effective_from)))[0];
}

// ------------------------------------------------------------------ importing

export async function importFile(ctx: AppContext, actor: Actor, kindRaw: string, b: { file: string; fileName?: string; dryRun: boolean }): Promise<BulkResult> {
  const kind = bulkKind(kindRaw);
  const buf = Buffer.from(b.file, 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES) throw badRequest(`The file must be an Excel (.xlsx) file of at most ${MAX_BYTES / 1024 / 1024} MB.`, 'BAD_FILE');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw badRequest('This is not an Excel (.xlsx) file. Save it as "Excel Workbook (*.xlsx)" and upload again.', 'BAD_FILE');
  return kind === 'employees' ? importEmployees(ctx, actor, buf, b) : importSalaries(ctx, actor, buf, b);
}

const empty = (kind: BulkKind, dryRun: boolean, fileErrors: string[]): BulkResult => ({ kind, dryRun, applied: false, total: 0, created: 0, updated: 0, unchanged: 0, errorCount: fileErrors.length, rows: [], fileErrors });

function summarise(kind: BulkKind, dryRun: boolean, rows: BulkRowResult[]): BulkResult {
  const count = (a: BulkRowResult['action']) => rows.filter((r) => r.action === a).length;
  return { kind, dryRun, applied: false, total: rows.length, created: count('create'), updated: count('update'), unchanged: count('unchanged'), errorCount: count('error'), rows, fileErrors: [] };
}

async function importEmployees(ctx: AppContext, actor: Actor, buf: Buffer, b: { fileName?: string; dryRun: boolean }): Promise<BulkResult> {
  await authorizeCompanyWide(ctx, actor, 'employees', 'write');
  const { rows: sheet, fileErrors } = await readSheet(buf, EMPLOYEE_COLS);
  if (fileErrors.length) return empty('employees', b.dryRun, fileErrors);
  const tab = (ctx.idx as SchemaIndex).tab('EMPLOYEES');
  const L = await lookups(ctx);
  const byName = (rows: Row[], key: string, nameKey: string) => new Map<string, string>([...rows.map((r): [string, string] => [str(r[nameKey]).trim().toLowerCase(), str(r[key])]), ...rows.map((r): [string, string] => [str(r[key]).toLowerCase(), str(r[key])])]);
  const maps: Record<Exclude<RefKind, 'manager'>, { m: Map<string, string>; label: string }> = {
    department: { m: byName(L.departments, 'department_id', 'name'), label: 'Department' }, designation: { m: byName(L.designations, 'designation_id', 'name'), label: 'Designation' },
    location: { m: byName(L.locations, 'location_id', 'name'), label: 'Branch' }, shift: { m: byName(L.shifts, 'shift_id', 'shift_name'), label: 'Default Shift' },
  };
  const existingByCode = new Map(L.employees.map((e) => [str(e.employee_code).trim().toLowerCase(), e]));
  const idByCode = new Map(L.employees.map((e) => [str(e.employee_code).trim().toLowerCase(), str(e.employee_id)]));
  const scope = await scopedEmployeeIds(ctx, actor.user, 'employees', 'write');
  const branches = actor.user.locationScope;
  const branchLimited = branches.length > 0 && !branches.includes('ALL');
  const header = new Map(EMPLOYEE_COLS.map((c) => [c.key, c.header]));
  const createSchema = schemaForTab(tab, { omit: [...SYSTEM_COLS, 'status'], forceOptional: ['employee_id'] });
  const updateSchema = schemaForTab(tab, { omit: [...SYSTEM_COLS, 'status', 'employee_id'], partial: true }).partial();

  // codes in this file get their ids first, so a manager can be someone in the same file
  const newIds = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of sheet) {
    const code = str(r.values.employee_code).trim().toLowerCase();
    if (code && !idByCode.has(code) && !newIds.has(code)) newIds.set(code, ctx.id('E'));
  }

  const results: BulkRowResult[] = [];
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<{ key: string; patch: Record<string, unknown>; before: Row }> = [];
  for (const r of sheet) {
    const errors: string[] = [];
    const fields: Record<string, unknown> = {};
    const code = str(r.values.employee_code).trim();
    const codeKey = code.toLowerCase();
    if (!code) errors.push('Employee Code is required');
    else if (seen.has(codeKey)) errors.push(`Employee Code "${code}" appears more than once in the file`);
    seen.add(codeKey);
    const existing = existingByCode.get(codeKey);
    const isNew = !!code && !existing;
    for (const c of EMPLOYEE_COLS) {
      const v = r.values[c.key];
      if (blank(v)) continue;
      switch (c.type) {
        case 'text': fields[c.key] = String(v).trim(); break;
        case 'date': { const d = toIsoDate(v); if (d) fields[c.key] = d; else errors.push(`${c.header}: "${String(v)}" is not a date (use dd-mm-yyyy)`); break; }
        case 'enum': { const e = toEnum(v, c.enumName!); if (e) fields[c.key] = e; else errors.push(`${c.header}: "${String(v)}" is not allowed (${(ENUMS[c.enumName!] as string[]).join(', ')})`); break; }
        case 'yn': { const y = toYn(v); if (y) fields[c.key] = y; else errors.push(`${c.header}: use Y or N`); break; }
        case 'ref': {
          if (c.ref === 'manager') {
            const mk = String(v).trim().toLowerCase();
            const id = idByCode.get(mk) ?? newIds.get(mk);
            if (!id) errors.push(`Manager Employee Code "${String(v)}" was not found`);
            else if (mk === codeKey) errors.push('A person cannot be their own manager');
            else fields[c.key] = id;
          } else {
            const ref = maps[c.ref as Exclude<RefKind, 'manager'>];
            const id = ref.m.get(String(v).trim().toLowerCase());
            if (!id) errors.push(`${ref.label}: "${String(v)}" does not exist (pick it from the drop-down; add it in Settings first)`); else fields[c.key] = id;
          }
          break;
        }
        default: break;
      }
    }
    if (fields.weekly_off_pattern) {
      const days = String(fields.weekly_off_pattern).toUpperCase().split(/[\s,;/]+/).filter(Boolean);
      if (days.some((d) => !DAYS.includes(d))) errors.push('Weekly Off: use day codes MON,TUE,WED,THU,FRI,SAT,SUN');
      else fields.weekly_off_pattern = [...new Set(days)].join(',');
    }
    if (isNew) {
      if (blank(r.values.first_name)) errors.push('First Name is required');
      if (blank(r.values.date_of_joining)) errors.push('Date of Joining is required');
      if (fields.date_of_exit && fields.date_of_joining && String(fields.date_of_exit) < String(fields.date_of_joining)) errors.push('Date of Exit is before Date of Joining');
    }
    if (branchLimited && fields.location_id && !branches.includes(String(fields.location_id))) errors.push('Branch is outside your branch scope');
    if (isNew && branchLimited && !fields.location_id) errors.push('Branch is required for you (you manage specific branches only)');

    if (existing) {
      if (scope !== 'ALL' && !scope.has(str(existing.employee_id))) errors.push('This employee is outside your scope');
      if (existing.status === 'INACTIVE') errors.push('This employee is archived. Restore them in the app first');
      if (!errors.length) {
        const parsed = updateSchema.safeParse(fields);
        if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${header.get(String(i.path[0])) ?? i.path.join('.')}: ${i.message}`);
        else {
          const patch: Record<string, unknown> = {};
          const changes: string[] = [];
          for (const [k, v] of Object.entries(parsed.data as Record<string, unknown>)) {
            if (v === undefined || v === null || k === 'employee_code') continue;
            if (str(existing[k]) !== String(v)) { patch[k] = v; changes.push(header.get(k) ?? k); }
          }
          if (!changes.length) results.push({ row: r.row, key: code, action: 'unchanged', changes: [], errors: [] });
          else { results.push({ row: r.row, key: code, action: 'update', changes, errors: [] }); updates.push({ key: str(existing.employee_id), patch, before: existing }); }
          continue;
        }
      }
    } else if (isNew && !errors.length) {
      const body = { ...fields, employee_code: code, employee_status: fields.employee_status ?? 'ACTIVE' };
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${header.get(String(i.path[0])) ?? i.path.join('.')}: ${i.message}`);
      else {
        creates.push({ ...(parsed.data as Record<string, unknown>), employee_id: newIds.get(codeKey)! });
        results.push({ row: r.row, key: code, action: 'create', changes: [], errors: [] });
        continue;
      }
    }
    results.push({ row: r.row, key: code || `row ${r.row}`, action: 'error', changes: [], errors });
  }
  results.sort((a, c) => a.row - c.row);
  const out = summarise('employees', b.dryRun, results);
  if (b.dryRun || out.errorCount || (!creates.length && !updates.length)) return out;

  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const reason = `Bulk import${b.fileName ? ` (${b.fileName.slice(0, 80)})` : ''}`;
  const made = creates.length ? await ctx.repo.appendMany('EMPLOYEES', creates.map((c) => ({ ...c, ...auditCols(ctx, actor) }))) : [];
  const changed = updates.length
    ? await ctx.repo.updateMany('EMPLOYEES', updates.map((u) => ({ key: u.key, patch: { ...u.patch, updated_at: now, updated_by: actor.user.userId, request_id: actor.requestId } })))
    : [];
  await ctx.audit.writeMany(actor, [
    ...made.map((row) => ({ action: 'EMPLOYEES_CREATED', entityType: 'EMPLOYEES', entityId: str(row.employee_id), after: row, reason })),
    ...changed.map((x) => ({ action: 'EMPLOYEES_UPDATED', entityType: 'EMPLOYEES', entityId: str(x.after.employee_id), before: x.before, after: x.after, reason })),
  ]);
  return { ...out, applied: true };
}

async function importSalaries(ctx: AppContext, actor: Actor, buf: Buffer, b: { fileName?: string; dryRun: boolean }): Promise<BulkResult> {
  const scope = await scopedEmployeeIds(ctx, actor.user, 'salary', 'write');
  if (scope !== 'ALL' && scope.size === 0) throw forbidden();
  const { rows: sheet, fileErrors } = await readSheet(buf, SALARY_COLS);
  if (fileErrors.length) return empty('salaries', b.dryRun, fileErrors);
  const tab = (ctx.idx as SchemaIndex).tab('EMPLOYEE_SALARY');
  const [emps, sal] = await Promise.all([ctx.repo.readAll('EMPLOYEES'), ctx.repo.readAll('EMPLOYEE_SALARY')]);
  const byCode = new Map(emps.map((e) => [str(e.employee_code).trim().toLowerCase(), e]));
  const schema = schemaForTab(tab, { omit: [...SYSTEM_COLS, 'status'], forceOptional: ['salary_id'] });
  const header = new Map(SALARY_COLS.map((c) => [c.key, c.header]));
  const versions = new Map<string, number>();
  const taken = new Set(sal.filter((r) => r.status !== 'INACTIVE').map((r) => `${str(r.employee_id)}:${str(r.effective_from)}`));
  const results: BulkRowResult[] = [];
  const creates: Array<Record<string, unknown>> = [];
  const befores: Array<Row | undefined> = [];

  for (const r of sheet) {
    const errors: string[] = [];
    const code = str(r.values.employee_code).trim();
    const emp = byCode.get(code.toLowerCase());
    if (!code) errors.push('Employee Code is required');
    else if (!emp) errors.push(`Employee Code "${code}" was not found`);
    else if (scope !== 'ALL' && !scope.has(str(emp.employee_id))) errors.push('This employee is outside your scope');
    else if (emp.status === 'INACTIVE') errors.push('This employee is archived');
    const dateRaw = r.values.effective_from;
    const date = blank(dateRaw) ? null : toIsoDate(dateRaw);
    const amounts: Record<string, number> = {};
    for (const k of MONEY_KEYS) {
      const v = r.values[k];
      if (blank(v)) continue;
      const n = toMoney(v);
      if (n === null || n < 0) errors.push(`${header.get(k)}: "${String(v)}" is not a valid amount (numbers only, 0 or more)`); else amounts[k] = n;
    }
    // a row without an Effective From (the downloaded template has none) is "no change requested"
    if (blank(dateRaw) && !errors.length && !Object.keys(amounts).length) { results.push({ row: r.row, key: code, action: 'unchanged', changes: [], errors: [] }); continue; }
    if (blank(dateRaw)) errors.push('Effective From is required');
    else if (!date) errors.push(`Effective From: "${String(dateRaw)}" is not a date (use dd-mm-yyyy)`);
    if (!errors.length && emp && date) {
      const gross = Object.values(amounts).reduce((n, x) => n + x, 0);
      if (gross <= 0) errors.push('Enter at least one amount above 0');
      const id = str(emp.employee_id);
      if (taken.has(`${id}:${date}`)) errors.push(`${code} already has a salary starting ${date}. Salary rows are never edited: use a different Effective From`);
      const locked = await lockedPeriodFor(ctx, date);
      if (locked) errors.push(`${date} falls in the LOCKED payroll period ${str(locked.period_id)}. Use a later date and post arrears as a payroll input`);
      if (!errors.length) {
        const cur = structureOn(sal, id, date);
        if (cur && MONEY_KEYS.every((k) => Number(cur[k] ?? 0) === (amounts[k] ?? 0))) { results.push({ row: r.row, key: code, action: 'unchanged', changes: [], errors: [] }); continue; }
        const version = (versions.get(id) ?? sal.filter((x) => str(x.employee_id) === id).length) + 1;
        const body = { employee_id: id, effective_from: date, ...amounts, revision_reason: str(r.values.revision_reason).trim() || 'Bulk update', version };
        const parsed = schema.safeParse(body);
        if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${header.get(String(i.path[0])) ?? i.path.join('.')}: ${i.message}`);
        else {
          versions.set(id, version);
          taken.add(`${id}:${date}`);
          creates.push(parsed.data as Record<string, unknown>);
          befores.push(cur);
          results.push({ row: r.row, key: code, action: 'create', changes: [`from ${date}: gross ${Object.values(amounts).reduce((n, x) => n + x, 0).toLocaleString('en-IN')}`], errors: [] });
          continue;
        }
      }
    }
    results.push({ row: r.row, key: code || `row ${r.row}`, action: 'error', changes: [], errors });
  }
  results.sort((a, c) => a.row - c.row);
  const out = summarise('salaries', b.dryRun, results);
  if (b.dryRun || out.errorCount || !creates.length) return out;

  const reason = `Bulk import${b.fileName ? ` (${b.fileName.slice(0, 80)})` : ''}`;
  const made = await ctx.repo.appendMany('EMPLOYEE_SALARY', creates.map((c) => ({ ...c, salary_id: ctx.id('SAL'), ...auditCols(ctx, actor) })));
  await ctx.audit.writeMany(actor, made.map((row, i) => ({ action: 'EMPLOYEE_SALARY_CREATED', entityType: 'EMPLOYEE_SALARY', entityId: str(row.salary_id), before: befores[i], after: row, reason })));
  return { ...out, applied: true };
}

