import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, TEST_PASSWORD, key, makeApi } from '../api-helpers';

let api: ApiEnv;
let emp: string, mgr: string, hr: string, hrPune: string, fin: string, oper: string, root: string;

beforeAll(async () => {
  api = await makeApi({ scaffold: false });
  [emp, mgr, hr, hrPune, fin, oper, root] = await Promise.all([EMAIL.emp, EMAIL.mgr, EMAIL.hr, EMAIL.hrPune, EMAIL.fin, EMAIL.oper, EMAIL.root].map((e) => api.login(e)));
});

describe('authentication', () => {
  it('rejects unauthenticated access to every protected area', async () => {
    for (const url of ['/api/attendance/daily?from=2026-09-01&to=2026-09-02', '/api/leave/balances', '/api/payroll/periods', '/api/users', '/api/audit', '/api/r/employees', '/api/attendance/events?from=2026-09-01&to=2026-09-02', '/api/reports']) {
      expect((await api.call(null, 'GET', url)).status, url).toBe(401);
    }
  });

  it('requires the CSRF header on state-changing calls', async () => {
    const r = await api.app.inject({ method: 'POST', url: '/api/attendance/punch', payload: {}, headers: { cookie: emp, 'idempotency-key': key() } });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe('CSRF');
  });

  it('does not reveal whether an email exists and locks after repeated failures', async () => {
    const a = await api.call(null, 'POST', '/api/auth/login', { email: 'nobody@demo.nutex.example', password: 'x' });
    const b = await api.call(null, 'POST', '/api/auth/login', { email: EMAIL.night, password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    for (let i = 0; i < 4; i++) await api.call(null, 'POST', '/api/auth/login', { email: EMAIL.night, password: 'wrong' });
    const locked = await api.call(null, 'POST', '/api/auth/login', { email: EMAIL.night, password: TEST_PASSWORD });
    expect(locked.status).toBe(423);
  });

  it('session cookie is httpOnly + SameSite=Strict', async () => {
    const r = await api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL.mgr, password: TEST_PASSWORD }, headers: { 'x-requested-with': 'nutex' } });
    const c = r.cookies.find((x) => x.name === 'nutex_session')!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe('strict');
  });

  it('a disabled account loses its existing session immediately', async () => {
    const opCookie = await api.login(EMAIL.oper);
    expect((await api.call(opCookie, 'GET', '/api/auth/me')).status).toBe(200);
    const u = await api.ctx.repo.findOne('USERS', (r) => r.email === EMAIL.oper);
    const upd = await api.call(root, 'PATCH', `/api/users/${u!.user_id}`, { status: 'DISABLED' });
    expect(upd.status).toBe(200);
    expect((await api.call(opCookie, 'GET', '/api/auth/me')).status).toBe(401);
    await api.call(root, 'PATCH', `/api/users/${u!.user_id}`, { status: 'ACTIVE' });
  });

  it('logout revokes the session token', async () => {
    const c = await api.login(EMAIL.mgr);
    expect((await api.call(c, 'POST', '/api/auth/logout')).status).toBe(200);
    expect((await api.call(c, 'GET', '/api/auth/me')).status).toBe(401);
  });
});

describe('role and object-level authorization', () => {
  it('an employee reads only their own attendance', async () => {
    const own = await api.call(emp, 'GET', `/api/attendance/me?from=2026-09-01&to=2026-09-02`);
    expect(own.status).toBe(200);
    const other = await api.call(emp, 'GET', `/api/attendance/daily?from=2026-09-01&to=2026-09-02&employeeId=${IDS.hr}`);
    expect(other.status).toBe(403);
  });

  it('an employee cannot reach salary, users, audit, payroll, other people\'s check-in locations or other people\'s balances', async () => {
    expect((await api.call(emp, 'GET', `/api/attendance/events?from=2026-09-01&to=2026-09-30&employeeId=${IDS.hr}`)).status).toBe(403);
    for (const url of ['/api/r/statutory-rules', '/api/users', '/api/audit', '/api/payroll/periods', '/api/full-final', `/api/leave/balances?employeeId=${IDS.hr}`, '/api/settings']) {
      expect((await api.call(emp, 'GET', url)).status, url).toBe(403);
    }
  });

  it('SELF-scoped grants never unlock company-wide configuration (regression)', async () => {
    const r = await api.call(emp, 'POST', '/api/r/leave-types', { code: 'X', name: 'Hack', category: 'LEAVE' });
    expect(r.status).toBe(403);
    const h = await api.call(emp, 'POST', '/api/r/holidays', { holiday_date: '2026-12-25', name: 'Hack day' });
    expect(h.status).toBe(403);
  });

  it('a manager sees their team but not other employees, and only their own salary', async () => {
    expect((await api.call(mgr, 'GET', `/api/attendance/daily?from=2026-09-01&to=2026-09-02&employeeId=${IDS.emp}`)).status).toBe(200);
    expect((await api.call(mgr, 'GET', `/api/attendance/daily?from=2026-09-01&to=2026-09-02&employeeId=${IDS.fin}`)).status).toBe(403);
    const ms = await api.call(mgr, 'GET', '/api/r/salaries');
    expect(ms.status).toBe(200);
    expect(ms.body.every((r: any) => r.employee_id === IDS.mgr)).toBe(true);
  });

  it('HR is branch-scoped: an HR admin for Pune cannot read or edit HQ employees', async () => {
    expect((await api.call(hrPune, 'GET', `/api/r/employees/${IDS.emp}`)).status).toBe(403);
    expect((await api.call(hrPune, 'PATCH', `/api/r/employees/${IDS.emp}`, { phone: '999' })).status).toBe(403);
    expect((await api.call(hr, 'GET', `/api/r/employees/${IDS.emp}`)).status).toBe(200);
    const list = await api.call(hrPune, 'GET', '/api/r/employees');
    expect(list.status).toBe(200);
    expect(list.body.every((e: any) => e.location_id === IDS.loc2)).toBe(true);
  });

  it('HR cannot create an employee in a branch outside its scope', async () => {
    const r = await api.call(hr, 'POST', '/api/r/employees', { employee_code: 'V0500', first_name: 'Out', date_of_joining: '2026-09-01', location_id: IDS.loc2, employment_type: 'PERMANENT', employee_status: 'ACTIVE' });
    expect(r.status).toBe(403);
  });

  it('check-in locations are branch data: HR and the site clerk read their branch, an HR admin for another branch does not', async () => {
    const q = '/api/attendance/events?from=2026-09-01&to=2026-09-30';
    expect((await api.call(hr, 'GET', q)).status).toBe(200);
    expect((await api.call(oper, 'GET', q)).status).toBe(200);
    expect((await api.call(hrPune, 'GET', `${q}&employeeId=${IDS.emp}`)).status).toBe(403);
    // nobody but the location-verified punch endpoint may write raw events
    expect((await api.call(oper, 'POST', '/api/attendance/manual-punch', { employeeId: IDS.emp, type: 'IN', at: '2026-09-01T09:00:00', reason: 'not allowed' })).status).toBe(403);
  });

  it('finance can read salary but not manage users; only the owner changes settings', async () => {
    expect((await api.call(fin, 'GET', '/api/r/salaries')).status).toBe(200);
    expect((await api.call(fin, 'GET', '/api/users')).status).toBe(403);
    expect((await api.call(emp, 'GET', '/api/users')).status).toBe(403);
    expect((await api.call(hr, 'GET', '/api/users')).status).toBe(200); // HR sees the logins of their own branch
    expect((await api.call(root, 'GET', '/api/users')).status).toBe(200);
    expect((await api.call(hr, 'PUT', '/api/settings/DAY_BOUNDARY_HOURS', { value: 5, reason: 'testing change' })).status).toBe(403);
  });

  it('salary passwords hashes and bank references never leave the API', async () => {
    const u = await api.call(root, 'GET', '/api/users');
    expect(JSON.stringify(u.body)).not.toMatch(/scrypt|password_hash/);
    const e = await api.call(hr, 'GET', `/api/r/employees/${IDS.emp}`);
    expect(e.body.bank_account_ref).toBeUndefined();
  });
});

describe('input hardening', () => {
  it('rejects mass assignment of formula / system columns', async () => {
    const r = await api.call(hr, 'POST', '/api/r/holidays', { holiday_date: '2026-12-25', name: 'Xmas', effective_date: '2026-01-01', created_by: 'root' });
    expect(r.status).toBe(400);
  });

  it('rejects spreadsheet formula injection in text fields', async () => {
    const r = await api.call(hr, 'POST', '/api/r/holidays', { holiday_date: '2026-12-25', name: '=HYPERLINK("http://evil","x")' });
    expect(r.status).toBe(400);
    const ok = await api.call(hr, 'POST', '/api/r/holidays', { holiday_date: '2026-12-25', name: 'Christmas', holiday_type: 'PUBLIC', location_id: 'ALL' });
    expect(ok.status).toBe(200);
  });

  it('punch body cannot name another employee', async () => {
    const r = await api.call(emp, 'POST', '/api/attendance/punch', { employeeId: IDS.hr, type: 'IN' }, { 'idempotency-key': key() });
    expect(r.status).toBe(400);
  });

  it('errors do not leak internals and carry a request id', async () => {
    const r = await api.call(emp, 'GET', '/api/r/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.requestId).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts|node_modules/);
  });

  it('every mutation above left an audit trail with the actor and request id', async () => {
    const chk = await api.call(root, 'GET', '/api/audit/verify');
    expect(chk.body.ok).toBe(true);
    const log = await api.call(root, 'GET', '/api/audit?action=LOGIN_FAILED');
    expect(log.body.total).toBeGreaterThanOrEqual(5);
    expect(log.body.rows[0].request_id).toBeTruthy();
  });
});
