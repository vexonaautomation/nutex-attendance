import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../api-helpers';

let api: ApiEnv;
let root: string, hr: string, emp: string;

const rawLogin = (username: string, password: string) => api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: username, password }, headers: { 'x-requested-with': 'nutex' } });
const cookieOf = (r: Awaited<ReturnType<typeof rawLogin>>) => `nutex_session=${r.cookies.find((c) => c.name === 'nutex_session')!.value}`;
/** the test clock is frozen; sessions and password changes have one-second resolution, so let real time pass between them */
const later = (seconds: number) => api.clock.set(new Date(api.clock.now.getTime() + seconds * 1000).toISOString());
const newEmployee = (id: string, code: string, first: string, over: Record<string, unknown> = {}) => ({
  employee_id: id, employee_code: code, first_name: first, last_name: 'Newhire', date_of_joining: '2026-09-01', employment_type: 'PERMANENT', employee_status: 'ACTIVE', location_id: IDS.loc,
  default_shift_id: IDS.shiftGen, weekly_off_pattern: 'SAT,SUN', ot_eligible: 'N', pf_applicable: 'N', esi_applicable: 'N', pt_applicable: 'N', ...over,
});
const users = async () => (await api.call(root, 'GET', '/api/users')).body as Array<{ userId: string; username: string; status: string; role: string; mustChangePassword: boolean; employeeId: string }>;

beforeAll(async () => {
  api = await makeApi({ env: { LOGIN_RATE_LIMIT_PER_MIN: 1000 } }); // clock: 2026-09-29 09:30 IST; many sign-ins in one second
  [root, hr, emp] = await Promise.all([EMAIL.root, EMAIL.hr, EMAIL.emp].map((e) => api.login(e)));
});

describe('the administrator adds an employee and issues their username and password', () => {
  let userId = '';
  let temp = '';

  it('creates the employee, then a login with a generated password that is shown once', async () => {
    const e = await api.call(root, 'POST', '/api/r/employees', newEmployee('E201', 'V0201', 'Ravi'));
    expect(e.status).toBe(200);
    const r = await api.call(root, 'POST', '/api/users', { employeeId: 'E201', username: 'ravi.kumar', displayName: 'Ravi Newhire', role: 'EMPLOYEE' });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe('ravi.kumar');
    expect(r.body.mustChangePassword).toBe(true);
    temp = r.body.temporaryPassword;
    userId = r.body.userId;
    expect(temp).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(temp).toMatch(/[a-z]/i);
    expect(temp).toMatch(/\d/);
    // the password is stored only as a hash, and is never listed again
    const row = await api.ctx.repo.getByKey('USERS', userId);
    expect(String(row!.password_hash)).toMatch(/^scrypt\$/);
    expect(JSON.stringify(await users())).not.toContain(temp);
    expect(row).toMatchObject({ location_scope: IDS.loc, status: 'ACTIVE', must_change_password: 'Y' });
  });

  it('the new person signs in with it, but can do nothing until they choose their own password', async () => {
    const l = await rawLogin('ravi.kumar', temp);
    expect(l.statusCode).toBe(200);
    expect(l.json().user.mustChangePassword).toBe(true);
    const cookie = cookieOf(l);
    const me = await api.call(cookie, 'GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    for (const url of ['/api/dashboard', '/api/attendance/policy', '/api/attendance/me?from=2026-09-01&to=2026-09-30']) {
      const r = await api.call(cookie, 'GET', url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    const punch = await api.call(cookie, 'POST', '/api/attendance/punch', { type: 'AUTO' }, { 'idempotency-key': key() });
    expect(punch.status).toBe(403);
    expect(punch.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('a weak, unchanged or username-like new password is refused; a good one unlocks the account and keeps the session', async () => {
    const l = await rawLogin('ravi.kumar', temp);
    const cookie = cookieOf(l);
    const change = (next: string, current = temp) => api.call(cookie, 'POST', '/api/auth/change-password', { current, next });
    expect((await change('short1')).body.error.code).toBe('WEAK_PASSWORD');
    expect((await change('onlyletters')).body.error.code).toBe('WEAK_PASSWORD');
    expect((await change('Ravi.Kumar')).status).toBe(400); // letters only, and equal to the username
    expect((await change(temp)).body.error.message).toMatch(/different/);
    expect((await change('Sunrise2026', 'wrong-current')).status).toBe(401);
    later(5);
    const ok = await api.app.inject({ method: 'POST', url: '/api/auth/change-password', payload: { current: temp, next: 'Sunrise2026' }, headers: { 'x-requested-with': 'nutex', cookie } });
    expect(ok.statusCode).toBe(200);
    const fresh = `nutex_session=${ok.cookies.find((c) => c.name === 'nutex_session')!.value}`;
    // the old session ended with the password change; the one issued in the response keeps working
    expect((await api.call(cookie, 'GET', '/api/auth/me')).status).toBe(401);
    expect((await api.call(fresh, 'GET', '/api/dashboard')).status).toBe(200);
    expect((await rawLogin('ravi.kumar', temp)).statusCode).toBe(401);
    expect((await rawLogin('ravi.kumar', 'Sunrise2026')).json().user.mustChangePassword).toBe(false);
  });

  it('then checks in with their location like anybody else', async () => {
    const cookie = cookieOf(await rawLogin('ravi.kumar', 'Sunrise2026'));
    const r = await api.call(cookie, 'POST', '/api/attendance/punch', { type: 'AUTO', geo: { lat: 19.0761, lng: 72.8778, accuracy: 10, capturedAt: api.clock.now.getTime() } }, { 'idempotency-key': key() });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ type: 'IN', lat: 19.0761 });
    // the day row was created on the fly for the new person
    expect((await api.call(cookie, 'GET', '/api/attendance/me?from=2026-09-29&to=2026-09-29')).body).toHaveLength(1);
  });

  it('the creation is audited without the password', async () => {
    const a = await api.ctx.repo.find('AUDIT_LOG', (x) => x.action === 'USER_CREATED' && x.entity_id === userId);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a)).not.toContain(temp);
    expect(JSON.stringify(a)).not.toContain('Sunrise2026');
  });
});

describe('the administrator chooses the password', () => {
  it('accepts a typed password (not echoed back) and lets the person keep it when force-change is off', async () => {
    await api.call(root, 'POST', '/api/r/employees', newEmployee('E202', 'V0202', 'Sita'));
    const r = await api.call(root, 'POST', '/api/users', { employeeId: 'E202', username: 'sita', displayName: 'Sita Newhire', role: 'MANAGER', password: 'Welcome2026', forceChange: false });
    expect(r.status).toBe(200);
    expect(r.body.temporaryPassword).toBeUndefined();
    const l = await rawLogin('sita', 'Welcome2026');
    expect(l.statusCode).toBe(200);
    expect(l.json().user.mustChangePassword).toBe(false);
    expect((await api.call(cookieOf(l), 'GET', '/api/dashboard')).status).toBe(200);
  });

  it('rejects a weak password, a taken username (any case), a second login for the same employee and an archived employee', async () => {
    await api.call(root, 'POST', '/api/r/employees', newEmployee('E203', 'V0203', 'Tara'));
    const base = { employeeId: 'E203', username: 'tara', displayName: 'Tara Newhire', role: 'EMPLOYEE' };
    expect((await api.call(root, 'POST', '/api/users', { ...base, password: 'abc' })).body.error.code).toBe('WEAK_PASSWORD');
    expect((await api.call(root, 'POST', '/api/users', { ...base, password: 'nodigitshere' })).body.error.code).toBe('WEAK_PASSWORD');
    expect((await api.call(root, 'POST', '/api/users', { ...base, password: 'Tara2026x', username: 'SITA' })).body.error.code).toBe('USERNAME_TAKEN');
    expect((await api.call(root, 'POST', '/api/users', { ...base, employeeId: 'E202', username: 'sita2', password: 'Another2026' })).body.error.code).toBe('EMPLOYEE_HAS_LOGIN');
    expect((await api.call(root, 'POST', '/api/users', { ...base, username: 'ab', password: 'Tara2026x' })).status).toBe(400); // too short
    expect((await api.call(root, 'POST', '/api/users', { ...base, username: 'bad name!', password: 'Tara2026x' })).status).toBe(400);
    expect((await api.call(root, 'POST', '/api/users', { ...base, employeeId: 'E999', password: 'Tara2026x' })).status).toBe(404);
  });

  it('only the owner and HR issue logins; employees, managers and finance cannot', async () => {
    const body = { employeeId: 'E203', username: 'tara', displayName: 'Tara Newhire', role: 'EMPLOYEE', password: 'Tara2026x' };
    const mgr = await api.login(EMAIL.mgr);
    const fin = await api.login(EMAIL.fin);
    for (const who of [emp, mgr, fin]) expect((await api.call(who, 'POST', '/api/users', body)).status).toBe(403);
    expect((await api.call(emp, 'PATCH', '/api/users/U003', { status: 'DISABLED' })).status).toBe(403);
  });
});

describe('HR admin gives the people of their own branch a username and password', () => {
  it('can issue and reset a login for an employee of their branch', async () => {
    await api.call(root, 'POST', '/api/r/employees', newEmployee('E210', 'V0210', 'Uma'));
    const r = await api.call(hr, 'POST', '/api/users', { employeeId: 'E210', username: 'uma.hr', displayName: 'Uma Newhire', role: 'EMPLOYEE' });
    expect(r.status).toBe(200);
    expect(r.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await rawLogin('uma.hr', r.body.temporaryPassword)).json().user.mustChangePassword).toBe(true);
    const id = r.body.userId as string;
    const again = await api.call(hr, 'PATCH', `/api/users/${id}`, { resetPassword: true });
    expect(again.status).toBe(200);
    expect(again.body.temporaryPassword).toBeTruthy();
    expect((await api.call(hr, 'PATCH', `/api/users/${id}`, { status: 'DISABLED' })).body.status).toBe('DISABLED');
    expect((await api.call(hr, 'GET', '/api/users')).body.some((u: { username: string }) => u.username === 'uma.hr')).toBe(true);
  });

  it('cannot give admin, HR or finance roles, nor touch such logins, nor reach another branch, nor change their own account', async () => {
    await api.call(root, 'POST', '/api/r/employees', newEmployee('E211', 'V0211', 'Veer'));
    for (const role of ['SUPER_ADMIN', 'HR_ADMIN', 'FINANCE_PAYROLL']) {
      expect((await api.call(hr, 'POST', '/api/users', { employeeId: 'E211', username: `veer.${role}`.toLowerCase(), displayName: 'Veer', role, password: 'Welcome2026' })).status, role).toBe(403);
    }
    expect((await api.call(hr, 'POST', '/api/users', { employeeId: 'E211', username: 'veer', displayName: 'Veer', role: 'EMPLOYEE', password: 'Welcome2026', locationScope: 'ALL' })).status).toBe(403);
    const all = (await users());
    const adminUser = all.find((u) => u.username === EMAIL.root)!;
    const hrUser = all.find((u) => u.username === EMAIL.hr)!;
    expect((await api.call(hr, 'PATCH', `/api/users/${adminUser.userId}`, { password: 'Hacked2026' })).status).toBe(403);
    expect((await api.call(hr, 'PATCH', `/api/users/${hrUser.userId}`, { resetPassword: true })).status).toBe(403); // not even their own
    const other = await api.call(root, 'POST', '/api/r/employees', newEmployee('E212', 'V0212', 'Wasim', { location_id: IDS.loc2 }));
    expect(other.status).toBe(200);
    expect((await api.call(hr, 'POST', '/api/users', { employeeId: 'E212', username: 'wasim', displayName: 'Wasim', role: 'EMPLOYEE', password: 'Welcome2026' })).status).toBe(403);
    const hrPune = await api.login(EMAIL.hrPune);
    expect((await api.call(hrPune, 'GET', '/api/users')).body.every((u: { employeeId: string }) => u.employeeId !== 'E210')).toBe(true); // other branch sees none of HQ
    // and the role cannot be raised through an update either
    const umaId = (await users()).find((u) => u.username === 'uma.hr')!.userId;
    expect((await api.call(hr, 'PATCH', `/api/users/${umaId}`, { role: 'HR_ADMIN' })).status).toBe(403);
    expect((await api.call(hr, 'PATCH', `/api/users/${umaId}`, { role: 'MANAGER' })).status).toBe(200);
  });
});

describe('the administrator manages existing logins', () => {
  const idOf = async (username: string) => (await users()).find((u) => u.username === username)!.userId;

  it('sets a new password: the old one and every session of that person stop working at once', async () => {
    const before = cookieOf(await rawLogin('sita', 'Welcome2026'));
    expect((await api.call(before, 'GET', '/api/dashboard')).status).toBe(200);
    later(5);
    const r = await api.call(root, 'PATCH', `/api/users/${await idOf('sita')}`, { password: 'Monsoon2026' });
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true); // somebody else chose it, so it is temporary by default
    expect((await api.call(before, 'GET', '/api/dashboard')).status).toBe(401);
    expect((await rawLogin('sita', 'Welcome2026')).statusCode).toBe(401);
    expect((await rawLogin('sita', 'Monsoon2026')).statusCode).toBe(200);
  });

  it('generates a new password on request and shows it once', async () => {
    const r = await api.call(root, 'PATCH', `/api/users/${await idOf('sita')}`, { resetPassword: true });
    expect(r.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await rawLogin('sita', r.body.temporaryPassword)).statusCode).toBe(200);
    expect(JSON.stringify(await api.ctx.repo.find('AUDIT_LOG', (a) => a.action === 'USER_UPDATED'))).not.toContain(r.body.temporaryPassword);
  });

  it('disables and re-enables a login; a disabled person is signed out on their very next request', async () => {
    const id = await idOf('sita');
    await api.call(root, 'PATCH', `/api/users/${id}`, { password: 'Monsoon2026', forceChange: false });
    const live = cookieOf(await rawLogin('sita', 'Monsoon2026'));
    expect((await api.call(live, 'GET', '/api/dashboard')).status).toBe(200);
    expect((await api.call(root, 'PATCH', `/api/users/${id}`, { status: 'DISABLED' })).body.status).toBe('DISABLED');
    expect((await api.call(live, 'GET', '/api/dashboard')).status).toBe(401);
    expect((await rawLogin('sita', 'Monsoon2026')).statusCode).toBe(401);
    expect((await api.call(root, 'PATCH', `/api/users/${id}`, { status: 'ACTIVE' })).body.status).toBe('ACTIVE');
    expect((await rawLogin('sita', 'Monsoon2026')).statusCode).toBe(200);
  });

  it('changes the username, name, role and branch access', async () => {
    const id = await idOf('sita');
    const r = await api.call(root, 'PATCH', `/api/users/${id}`, { username: 'sita.sharma', displayName: 'Sita Sharma', role: 'HR_ADMIN', locationScope: `${IDS.loc},${IDS.loc2}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'sita.sharma', role: 'HR_ADMIN' });
    expect((await rawLogin('sita', 'Monsoon2026')).statusCode).toBe(401);
    expect((await rawLogin('sita.sharma', 'Monsoon2026')).statusCode).toBe(200);
    expect((await api.call(root, 'PATCH', `/api/users/${id}`, { username: EMAIL.emp })).body.error.code).toBe('USERNAME_TAKEN');
    expect((await api.call(root, 'PATCH', `/api/users/${id}`, { role: 'GOD' })).status).toBe(400);
  });

  it('an administrator cannot lock themselves out', async () => {
    const mine = (await users()).find((u) => u.username === EMAIL.root)!.userId;
    expect((await api.call(root, 'PATCH', `/api/users/${mine}`, { status: 'DISABLED' })).status).toBe(400);
    expect((await api.call(root, 'PATCH', `/api/users/${mine}`, { role: 'EMPLOYEE' })).status).toBe(400);
  });
});

describe('removing an employee', () => {
  it('archives the employee and disables their login; nothing is deleted; restore brings the employee back but not the login', async () => {
    const list = () => api.call(root, 'GET', '/api/r/employees').then((r) => r.body as Array<{ employee_id: string; status: string; employee_status: string }>);
    const login = await rawLogin('ravi.kumar', 'Sunrise2026');
    const live = cookieOf(login);
    expect((await api.call(live, 'GET', '/api/dashboard')).status).toBe(200);

    const r = await api.call(root, 'POST', '/api/r/employees/E201/archive', { reason: 'Resigned, last day was yesterday' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'INACTIVE', employee_status: 'INACTIVE', disabledLogins: 1 });
    expect((await list()).find((e) => e.employee_id === 'E201')).toMatchObject({ status: 'INACTIVE' }); // still in the workbook
    expect((await api.call(live, 'GET', '/api/dashboard')).status).toBe(401);
    expect((await rawLogin('ravi.kumar', 'Sunrise2026')).statusCode).toBe(401);
    expect((await api.call(root, 'POST', '/api/users', { employeeId: 'E201', username: 'ravi2', displayName: 'Ravi', role: 'EMPLOYEE', password: 'Sunrise2027' })).body.error.code).toBe('EMPLOYEE_NOT_IN_SERVICE');

    const back = await api.call(root, 'POST', '/api/r/employees/E201/restore');
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'ACTIVE', employee_status: 'ACTIVE' });
    expect((await rawLogin('ravi.kumar', 'Sunrise2026')).statusCode).toBe(401); // the administrator re-enables logins on purpose
    const ravi = (await users()).find((u) => u.username === 'ravi.kumar')!;
    await api.call(root, 'PATCH', `/api/users/${ravi.userId}`, { status: 'ACTIVE' });
    expect((await rawLogin('ravi.kumar', 'Sunrise2026')).statusCode).toBe(200);
    expect((await api.call(root, 'POST', '/api/r/employees/E201/restore')).body.error.code).toBe('ALREADY_ACTIVE');
    expect((await api.ctx.repo.find('AUDIT_LOG', (a) => a.entity_id === 'E201' && /ARCHIVED|RESTORED/.test(String(a.action)))).length).toBe(2);
  });

  it('an administrator cannot archive their own employee record; an employee cannot archive anybody', async () => {
    expect((await api.call(root, 'POST', `/api/r/employees/${IDS.hr}/archive`, { reason: 'trying to remove myself' })).status).toBe(403);
    expect((await api.call(emp, 'POST', `/api/r/employees/${IDS.hr}/archive`, { reason: 'not allowed at all' })).status).toBe(403);
  });

  it('an archived employee cannot be given a check-in by anyone (not in service)', async () => {
    await api.call(root, 'POST', '/api/r/employees/E202/archive', { reason: 'left the company' });
    const r = await api.call(root, 'POST', '/api/attendance/manual-punch', { employeeId: 'E202', type: 'IN', at: '2026-09-29T09:00:00', reason: 'should not be possible' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('EMPLOYEE_NOT_IN_SERVICE');
  });
});

describe('the local test shortcut never weakens production', () => {
  it('the admin/123 test login exists only when the emulator is started in local test mode', async () => {
    expect((await rawLogin('admin', '123')).statusCode).toBe(401); // makeApi() does not enable devAdmin
  });
});

describe('timestamps in the workbook are company-local wall clock (regression: the +5:30 offset)', () => {
  it('a lock-out ends after LOGIN_LOCK_MINUTES, not hours later', async () => {
    for (let i = 0; i < 5; i++) await rawLogin(EMAIL.hrPune, 'wrong-password-1');
    expect((await rawLogin(EMAIL.hrPune, 'wrong-password-1')).statusCode).toBe(423);
    api.clock.set(new Date(api.clock.now.getTime() + 16 * 60_000).toISOString()); // default lock is 15 minutes
    const { TEST_PASSWORD } = await import('../api-helpers');
    expect((await rawLogin(EMAIL.hrPune, TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('a session issued right after a password change stays valid', async () => {
    const id = (await users()).find((u) => u.username === 'ravi.kumar')!.userId;
    later(5);
    await api.call(root, 'PATCH', `/api/users/${id}`, { password: 'Harvest2026', forceChange: false });
    const c = cookieOf(await rawLogin('ravi.kumar', 'Harvest2026'));
    expect((await api.call(c, 'GET', '/api/dashboard')).status).toBe(200);
  });
});

describe('a half-written USERS row (typed into the sheet by hand) is never a login', () => {
  it('is listed as incomplete, refuses a password-only update, and "Create login" completes that same row', async () => {
    await api.call(root, 'POST', '/api/r/employees', newEmployee('E213', 'V0213', 'Yash'));
    // what somebody typing straight into the Google Sheet leaves behind: an id and an employee, nothing else
    const next = (await api.ctx.repo.readAll('USERS')).length + 2;
    await api.ctx.repo.gateway.writeRanges([{ range: `USERS!A${next}:B${next}`, values: [['user 02', 'E213']] }]);
    api.ctx.repo.invalidate();
    const row = (await users()).find((u) => u.userId === 'user 02') as unknown as { incomplete: boolean; username: string | null };
    expect(row.incomplete).toBe(true);
    expect(row.username).toBeFalsy();
    // no login can come out of it, and a password alone (the old "Username: null") is refused
    expect((await rawLogin('', 'Whatever2026')).statusCode).toBe(400);
    const only = await api.call(root, 'PATCH', '/api/users/user 02', { password: 'Sunrise2026' });
    expect(only.status).toBe(400);
    expect(only.body.error.code).toBe('LOGIN_INCOMPLETE');
    // creating the login for that employee needs BOTH a username and a password, and finishes the same row (no second row)
    const before = (await users()).length;
    const done = await api.call(root, 'POST', '/api/users', { employeeId: 'E213', username: 'yash', displayName: 'Yash Newhire', role: 'EMPLOYEE', password: 'Sunrise2026', forceChange: false });
    expect(done.status).toBe(200);
    expect(done.body.userId).toBe('user 02');
    expect((await users()).length).toBe(before);
    expect((await users()).find((u) => u.userId === 'user 02')).toMatchObject({ username: 'yash', status: 'ACTIVE', role: 'EMPLOYEE' });
    expect((await rawLogin('yash', 'Sunrise2026')).statusCode).toBe(200);
    // and the creation form itself cannot be sent without a username
    expect((await api.call(root, 'POST', '/api/users', { employeeId: 'E213', displayName: 'Yash', role: 'EMPLOYEE', password: 'Sunrise2026' })).status).toBe(400);
  });
});
