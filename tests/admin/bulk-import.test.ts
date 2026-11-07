import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, makeApi } from '../api-helpers';

let api: ApiEnv;
let root: string, emp: string, hrPune: string;

/** an .xlsx made the way a person would: a header row and some rows */
async function book(headers: string[], rows: unknown[][], sheet = 'Data'): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const send = (kind: string, file: string, dryRun: boolean, who = root) => api.call(who, 'POST', `/api/bulk/${kind}/import`, { file, fileName: 'test.xlsx', dryRun });
const EMP_HEAD = ['Employee Code *', 'First Name *', 'Last Name', 'Email', 'Phone', 'Date of Joining *', 'Employment Type', 'Department', 'Manager Employee Code', 'Weekly Off', 'OT Eligible'];

beforeAll(async () => {
  api = await makeApi();
  [root, emp, hrPune] = await Promise.all([EMAIL.root, EMAIL.emp, EMAIL.hrPune].map((e) => api.login(e)));
});

describe('bulk template download', () => {
  it('employees: star on required columns, current people in the file, blank mode has none', async () => {
    const r = await api.call(root, 'GET', '/api/bulk/employees/template');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.raw as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Employees', 'Instructions', 'Lists']);
    const head = wb.getWorksheet('Employees')!.getRow(1).values as string[];
    expect(head).toContain('Employee Code *');
    expect(head).toContain('First Name *');
    expect(head).toContain('Date of Joining *');
    expect(head).toContain('Last Name');
    expect(wb.getWorksheet('Employees')!.rowCount).toBeGreaterThan(2);
    const blank = new ExcelJS.Workbook();
    await blank.xlsx.load((await api.call(root, 'GET', '/api/bulk/employees/template?mode=blank')).raw as unknown as ExcelJS.Buffer);
    expect(blank.getWorksheet('Employees')!.getRow(2).hasValues).toBe(false);
  });

  it('bank details are never exported', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await api.call(root, 'GET', '/api/bulk/employees/template')).raw as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Employees')!;
    const heads = ws.getRow(1).values as string[];
    const bankCol = heads.findIndex((h) => String(h).startsWith('Bank Account'));
    expect(bankCol).toBeGreaterThan(0);
    for (let r = 2; r <= ws.rowCount; r++) expect(ws.getRow(r).getCell(bankCol).value ?? null).toBeNull();
  });

  it('salary template lists each person with their current amounts', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await api.call(root, 'GET', '/api/bulk/salaries/template')).raw as unknown as ExcelJS.Buffer);
    const heads = wb.getWorksheet('Salaries')!.getRow(1).values as string[];
    expect(heads).toContain('Effective From *');
    expect(heads).toContain('Employee Code *');
    expect(wb.getWorksheet('Salaries')!.rowCount).toBeGreaterThan(2);
  });

  it('an ordinary employee cannot download or upload', async () => {
    expect((await api.call(emp, 'GET', '/api/bulk/employees/template')).status).toBe(403);
    expect((await api.call(emp, 'GET', '/api/bulk/salaries/template')).status).toBe(403);
    expect((await send('employees', await book(EMP_HEAD, []), true, emp)).status).toBe(403);
  });

  it('unknown type', async () => {
    expect((await api.call(root, 'GET', '/api/bulk/payroll/template')).status).toBe(400);
  });
});

describe('bulk employees', () => {
  it('rejects a file that is not an Excel file', async () => {
    const r = await send('employees', Buffer.from('a,b\n1,2\n'.repeat(30)).toString('base64'), true);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_FILE');
  });

  it('reports a missing required column', async () => {
    const r = await send('employees', await book(['First Name', 'Phone'], [['A', '123']]), true);
    expect(r.status).toBe(200);
    expect(r.body.fileErrors.join(' ')).toContain('Employee Code');
  });

  it('lists every problem with its row number and saves nothing', async () => {
    const before = (await api.ctx.repo.readAll('EMPLOYEES')).length;
    const file = await book(EMP_HEAD, [
      ['T-1', null, 'X', 'x@example.com', '9000000001', '2026-01-05', 'PERMANENT', null, null, null, null], // first name missing
      ['T-2', 'Two', null, null, null, 'not a date', 'PERMANENT', null, null, null, null], // bad date
      ['T-3', 'Three', null, null, null, '05-01-2026', 'WIZARD', null, null, null, null], // bad enum
      ['T-4', 'Four', null, null, null, '05-01-2026', null, 'No Such Dept', null, null, null], // unknown department
      ['T-5', 'Five', null, null, null, '05-01-2026', null, null, 'NOPE-9', null, null], // unknown manager
      ['T-6', 'Six', null, null, null, '05-01-2026', null, null, null, 'FUNDAY', null], // bad weekly off
      ['T-7', 'Seven', null, null, null, '05-01-2026', null, null, null, null, 'maybe'], // bad Y/N
      ['T-8', 'Eight', null, null, null, '05-01-2026', null, null, null, null, null],
      ['t-8', 'Eight again', null, null, null, '05-01-2026', null, null, null, null, null], // duplicate code in the file
    ]);
    const r = await send('employees', file, false); // even with dryRun false nothing is saved when a row is wrong
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    const msg = (code: string) => (r.body.rows.find((x: { key: string }) => x.key === code)?.errors ?? []).join(' | ');
    expect(msg('T-1')).toContain('First Name is required');
    expect(msg('T-2')).toContain('Date of Joining');
    expect(msg('T-3')).toContain('Employment Type');
    expect(msg('T-4')).toContain('Department');
    expect(msg('T-5')).toContain('Manager Employee Code');
    expect(msg('T-6')).toContain('Weekly Off');
    expect(msg('T-7')).toContain('OT Eligible');
    expect(r.body.rows.find((x: { row: number }) => x.row === 10).errors.join(' ')).toContain('more than once');
    expect(r.body.rows.find((x: { key: string }) => x.key === 'T-1').row).toBe(2);
    expect((await api.ctx.repo.readAll('EMPLOYEES')).length).toBe(before);
  });

  it('check-only (dry run) shows what would happen and saves nothing', async () => {
    const before = (await api.ctx.repo.readAll('EMPLOYEES')).length;
    const r = await send('employees', await book(EMP_HEAD, [['N-1', 'New', 'Person', 'new@example.com', '9000000002', '15-04-2026', 'PERMANENT', null, null, 'SAT,SUN', 'Y']]), true);
    expect(r.body).toMatchObject({ dryRun: true, applied: false, created: 1, errorCount: 0 });
    expect((await api.ctx.repo.readAll('EMPLOYEES')).length).toBe(before);
  });

  it('creates new people (a manager can be in the same file) and updates existing ones; a blank cell never clears a value', async () => {
    const existing = (await api.ctx.repo.readAll('EMPLOYEES'))[0];
    const code = String(existing.employee_code);
    const dep = (await api.ctx.repo.readAll('DEPARTMENTS'))[0];
    const file = await book(EMP_HEAD, [
      ['N-10', 'Boss', 'Person', 'boss@example.com', '9000000010', '1-4-2026', 'PERMANENT', String(dep.name), null, 'sat, sun', 'Y'],
      ['N-11', 'Report', 'Person', null, null, new Date(Date.UTC(2026, 3, 20)), null, null, 'n-10', null, null],
      [code, null, null, null, '9111111111', null, null, null, null, null, null],
    ]);
    const r = await send('employees', file, false);
    expect(r.body).toMatchObject({ applied: true, created: 2, updated: 1, errorCount: 0 });
    const all = await api.ctx.repo.readAll('EMPLOYEES');
    const boss = all.find((e) => e.employee_code === 'N-10')!;
    const rep = all.find((e) => e.employee_code === 'N-11')!;
    expect(boss).toMatchObject({ first_name: 'Boss', date_of_joining: '2026-04-01', weekly_off_pattern: 'SAT,SUN', department_id: dep.department_id, employee_status: 'ACTIVE', status: 'ACTIVE', ot_eligible: 'Y' });
    expect(rep.manager_employee_id).toBe(boss.employee_id);
    expect(rep.date_of_joining).toBe('2026-04-20');
    const upd = all.find((e) => e.employee_code === code)!;
    expect(String(upd.phone)).toBe('9111111111');
    expect(upd.first_name).toBe(existing.first_name);
    expect(upd.email).toEqual(existing.email);
  });

  it('writes one audit entry per row, and a second identical upload changes nothing', async () => {
    const audit = await api.ctx.repo.find('AUDIT_LOG', (r) => String(r.reason).startsWith('Bulk import') && String(r.entity_type) === 'EMPLOYEES');
    expect(audit.length).toBe(3);
    const file = await book(EMP_HEAD, [['N-10', 'Boss', 'Person', 'boss@example.com', '9000000010', '01-04-2026', 'PERMANENT', null, null, 'SAT,SUN', 'Y']]);
    const again = await send('employees', file, false);
    expect(again.body).toMatchObject({ applied: false, unchanged: 1, created: 0, updated: 0, errorCount: 0 });
  });
});

describe('bulk salary', () => {
  const HEAD = ['Employee Code *', 'Employee Name (info only)', 'Effective From *', 'Basic', 'HRA', 'DA', 'Conveyance', 'Special Allowance', 'Other Allowance', 'Reason'];
  let code = '';
  beforeAll(async () => { code = String((await api.ctx.repo.find('EMPLOYEES', (e) => e.employee_id === IDS.emp))[0].employee_code); });

  it('rejects unknown codes, bad dates and amounts, zero salary, and rows without a date', async () => {
    const r = await send('salaries', await book(HEAD, [
      ['NOPE', null, '01-05-2026', 1000],
      [code, null, 'someday', 1000],
      [code, null, '01-05-2026', 'abc'],
      [code, null, '01-05-2026', 0],
      [code, null, null, 5000],
    ]), true);
    expect(r.body.errorCount).toBe(5);
    const e = (i: number) => r.body.rows[i].errors.join(' | ');
    expect(e(0)).toContain('was not found');
    expect(e(1)).toContain('Effective From');
    expect(e(2)).toContain('Basic');
    expect(e(3)).toContain('at least one amount');
    expect(e(4)).toContain('Effective From is required');
  });

  it('creates a new dated version, keeps the old row, and audits it', async () => {
    const before = (await api.ctx.repo.find('EMPLOYEE_SALARY', (r) => r.employee_id === IDS.emp)).length;
    const r = await send('salaries', await book(HEAD, [[code, 'Employee Demo', '01-12-2026', '30,000', 12000, null, 2000, 6000, null, 'Annual revision']]), false);
    expect(r.body).toMatchObject({ applied: true, created: 1, errorCount: 0 });
    const rows = await api.ctx.repo.find('EMPLOYEE_SALARY', (x) => x.employee_id === IDS.emp);
    expect(rows.length).toBe(before + 1);
    const made = rows.find((x) => x.effective_from === '2026-12-01')!;
    expect(made).toMatchObject({ basic: 30000, hra: 12000, conveyance: 2000, special_allowance: 6000, revision_reason: 'Annual revision', status: 'ACTIVE' });
    expect(Number(made.monthly_gross)).toBe(50000);
    expect(made.version).toBe(before + 1);
    expect((await api.ctx.repo.find('AUDIT_LOG', (x) => x.action === 'EMPLOYEE_SALARY_CREATED')).length).toBe(1);
  });

  it('the same amounts again are unchanged, and the same date is refused (rows are never edited)', async () => {
    const same = await send('salaries', await book(HEAD, [[code, null, '01-01-2027', 30000, 12000, null, 2000, 6000]]), true);
    expect(same.body).toMatchObject({ unchanged: 1, created: 0, errorCount: 0 });
    const clash = await send('salaries', await book(HEAD, [[code, null, '01-12-2026', 99999]]), true);
    expect(clash.body.errorCount).toBe(1);
    expect(clash.body.rows[0].errors.join(' ')).toContain('already has a salary starting');
  });

  it('two rows for the same person and date in one file are refused', async () => {
    const r = await send('salaries', await book(HEAD, [[code, null, '01-03-2027', 1000], [code, null, '01-03-2027', 2000]]), true);
    expect(r.body.created).toBe(1);
    expect(r.body.errorCount).toBe(1);
  });

  it('a branch-limited HR never creates salaries outside their scope', async () => {
    const r = await send('salaries', await book(HEAD, [[code, null, '01-06-2027', 1000]]), true, hrPune);
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) expect(r.body.created).toBe(0);
  });
});
