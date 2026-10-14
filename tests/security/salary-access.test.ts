import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, makeApi } from '../api-helpers';

let api: ApiEnv;
let root: string, fin: string, hr: string, emp: string, mgr: string;
const structure = (employee_id: string, over: Record<string, unknown> = {}) => ({ employee_id, effective_from: '2026-10-01', basic: 20000, hra: 8000, conveyance: 1600, special_allowance: 4400, revision_reason: 'Joining', version: 1, ...over });

beforeAll(async () => {
  api = await makeApi();
  [root, fin, hr, emp, mgr] = await Promise.all([EMAIL.root, EMAIL.fin, EMAIL.hr, EMAIL.emp, EMAIL.mgr].map((e) => api.login(e)));
});

describe('who sets and who sees salary', () => {
  it('the owner and finance set a salary structure; HR, managers and employees cannot', async () => {
    const r = await api.call(root, 'POST', '/api/r/salaries', structure(IDS.night, { effective_from: '2026-11-01', version: 3 }));
    expect(r.status).toBe(200);
    expect(r.body.monthly_gross).toBe(34000);
    expect((await api.call(fin, 'POST', '/api/r/salaries', structure(IDS.emp, { effective_from: '2026-11-01', basic: 25000, version: 2, revision_reason: 'Annual revision' }))).status).toBe(200);
    for (const who of [hr, mgr, emp]) expect((await api.call(who, 'POST', '/api/r/salaries', structure(IDS.emp, { effective_from: '2026-12-01' }))).status).toBe(403);
  });

  it('a revision is a new dated row: history is never edited', async () => {
    expect((await api.call(root, 'PATCH', '/api/r/salaries/SAL-E003-1', { basic: 1 })).status).toBe(405);
    const list = await api.call(root, 'GET', '/api/r/salaries');
    expect(list.body.filter((x: any) => x.employee_id === IDS.emp).length).toBeGreaterThanOrEqual(2);
  });

  it('an employee sees only their own salary structure; HR sees none', async () => {
    const mine = await api.call(emp, 'GET', '/api/r/salaries');
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((x: any) => x.employee_id === IDS.emp)).toBe(true);
    expect((await api.call(emp, 'GET', `/api/r/salaries?employeeId=${IDS.hr}`)).body.every((x: any) => x.employee_id === IDS.emp)).toBe(true);
    expect((await api.call(hr, 'GET', '/api/r/salaries')).status).toBe(403);
  });

  it('a salary effective inside a LOCKED payroll period is refused', async () => {
    const r = await api.call(root, 'POST', '/api/r/salaries', structure(IDS.emp, { effective_from: '2026-08-10' }));
    expect(r.status).toBe(423);
  });
});
