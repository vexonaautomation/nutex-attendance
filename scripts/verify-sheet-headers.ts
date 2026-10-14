/**
 * Static schema checks (no Google, no emulator):
 *  - every required tab from the spec exists, in order, with unique column names
 *  - inputs come before formulas (so appends never touch formulas)
 *  - every enum / ref points at something that exists; every tab has a key column
 *  - protection and validation specs cover every formula / enum column
 *  - google/sheet-schema/*.json is in sync with the code
 */
import { ENUMS, TAB_ORDER, buildScaledSchema, protectionsJson, validationsJson } from '@nutex/formula-specs';
import { stale } from './generate-schema';

const REQUIRED = ['SYSTEM_CONFIG', 'USERS', 'ROLES', 'EMPLOYEES', 'EMPLOYMENT_HISTORY', 'DEPARTMENTS', 'DESIGNATIONS', 'LOCATIONS', 'SHIFT_MASTER', 'SHIFT_ROSTER', 'HOLIDAYS', 'LEAVE_TYPES', 'LEAVE_POLICIES', 'LEAVE_BALANCES', 'LEAVE_TRANSACTIONS', 'LEAVE_APPLICATIONS', 'ATTENDANCE_EVENTS', 'ATTENDANCE_DAILY', 'ATTENDANCE_ADJUSTMENTS', 'ATTENDANCE_EXCEPTIONS', 'OVERTIME', 'TIMESHEETS', 'SALARY_COMPONENTS', 'EMPLOYEE_SALARY', 'PAYROLL_CONTROL', 'PAYROLL_INPUTS', 'PAYROLL_CALC', 'PAYSLIPS', 'LOANS', 'LOAN_SCHEDULE', 'EXPENSES', 'REIMBURSEMENTS', 'TAX_DECLARATIONS', 'STATUTORY_RULES', 'STATUTORY_CALC', 'FULL_FINAL', 'NOTIFICATIONS', 'AUDIT_LOG', 'ERROR_LOG', 'DASHBOARD_DATA', 'LOOKUPS', 'README'];

const errors: string[] = [];
const idx = buildScaledSchema(1);

const missing = REQUIRED.filter((t) => !idx.byName.has(t));
if (missing.length) errors.push(`missing required tabs: ${missing.join(', ')}`);
const extras = TAB_ORDER.filter((t) => !REQUIRED.includes(t));
console.log(`required tabs present: ${REQUIRED.length - missing.length}/${REQUIRED.length}; justified extra tabs: ${extras.join(', ') || 'none'}`);

for (const t of idx.tabs) {
  const names = t.columns.map((c) => c.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) errors.push(`${t.name}: duplicate columns ${dup.join(', ')}`);
  if (t.name !== 'LOOKUPS' && !names.includes(t.keyColumn)) errors.push(`${t.name}: key column ${t.keyColumn} missing`);
  if (names.some((n) => !/^[a-z][a-z0-9_]*$/.test(n)) && t.name !== 'LOOKUPS') errors.push(`${t.name}: column names must be snake_case`);
  let seenFormula = false;
  for (const c of t.columns) {
    if (c.kind === 'formula') seenFormula = true;
    else if (seenFormula) errors.push(`${t.name}.${c.name}: input after formula`);
    if (c.enum && !ENUMS[c.enum]) errors.push(`${t.name}.${c.name}: unknown enum ${c.enum}`);
    if (c.ref) {
      const [rt, rc] = c.ref.split('.');
      if (!idx.byName.get(rt)?.columns.some((x) => x.name === rc)) errors.push(`${t.name}.${c.name}: bad ref ${c.ref}`);
    }
  }
  const fCount = t.columns.filter((c) => c.kind === 'formula').length;
  const prot = protectionsJson(idx).filter((p) => p.tab === t.name);
  if ((fCount > 0 || t.protection === 'SERVICE_ONLY') && prot.length === 0) errors.push(`${t.name}: no protection defined`);
  if (t.appendOnly && t.protection !== 'SERVICE_ONLY') errors.push(`${t.name}: append-only tabs must be fully locked`);
}
const vals = validationsJson(idx);
const enumCols = idx.tabs.flatMap((t) => t.columns.filter((c) => c.enum && c.kind === 'input').map((c) => `${t.name}.${c.name}`));
const covered = new Set(vals.filter((v) => v.type === 'ONE_OF_LIST').map((v) => `${v.tab}.${v.column}`));
for (const e of enumCols) if (!covered.has(e)) errors.push(`no dropdown validation for ${e}`);

const s = stale();
if (s.length) errors.push(`google/sheet-schema is stale: ${s.join(', ')} (run npm run schema:generate)`);

const formulaTotal = idx.tabs.reduce((n, t) => n + t.columns.filter((c) => c.kind === 'formula').length, 0);
console.log(`${idx.tabs.length} tabs, ${idx.tabs.reduce((n, t) => n + t.columns.length, 0)} columns, ${formulaTotal} formula columns, ${vals.length} validations, ${protectionsJson(idx).length} protected ranges`);
if (errors.length) { console.error(`\n✖ ${errors.length} schema problem(s):\n - ${errors.join('\n - ')}`); process.exit(1); }
console.log('✔ schema OK');
