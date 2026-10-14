import { describe, expect, it } from 'vitest';
import { loginBody } from '@nutex/validation';
import { buildApp } from '../../apps/api/src/app';
import { DEV_ADMIN, createEmulatorContext } from '../../apps/api/src/bootstrap';
import { loadEnv } from '../../apps/api/src/common/core';
import { EMAIL, TEST_PASSWORD } from '../api-helpers';

async function boot(o: { devAdmin?: boolean; env?: Record<string, number> } = {}) {
  const { ctx } = await createEmulatorContext({ rows: 40, big: { LEAVE_BALANCES: 80, LEAVE_TRANSACTIONS: 40, AUDIT_LOG: 150 }, password: TEST_PASSWORD, devAdmin: o.devAdmin, env: { NODE_ENV: 'test', ...o.env } });
  const app = await buildApp(ctx);
  await app.ready();
  const login = async (email: string, password: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-requested-with': 'nutex' } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, cookie: r.cookies.find((c) => c.name === 'nutex_session')?.value };
  };
  return { ctx, app, login };
}

describe('brute-force protection can be switched off for local testing, never in production', () => {
  it('production refuses to start with lockout or the rate limit disabled', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) };
    expect(() => loadEnv({ ...base, LOGIN_MAX_ATTEMPTS: '0' })).toThrow(/cannot be disabled in production/);
    expect(() => loadEnv({ ...base, LOGIN_RATE_LIMIT_PER_MIN: '0' })).toThrow(/cannot be disabled in production/);
    expect(loadEnv({ ...base }).LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(loadEnv({ NODE_ENV: 'development', LOGIN_MAX_ATTEMPTS: '0' }).LOGIN_MAX_ATTEMPTS).toBe(0);
    expect(() => loadEnv({ NODE_ENV: 'development', LOGIN_MAX_ATTEMPTS: '-1' })).toThrow(/>= 0/);
  });

  it('with lockout OFF, many wrong passwords never block the account and the right one still works', async () => {
    const { login } = await boot({ env: { LOGIN_MAX_ATTEMPTS: 0, LOGIN_RATE_LIMIT_PER_MIN: 0 } });
    for (let i = 0; i < 40; i++) expect((await login(EMAIL.emp, 'wrong')).status).toBe(401); // never 423 / 429
    expect((await login(EMAIL.emp, TEST_PASSWORD)).status).toBe(200);
  });

  it('with the default settings the account still locks (protection is on unless explicitly disabled)', async () => {
    const { login } = await boot({ env: { LOGIN_MAX_ATTEMPTS: 5, LOGIN_RATE_LIMIT_PER_MIN: 20 } });
    for (let i = 0; i < 5; i++) await login(EMAIL.emp, 'wrong');
    expect((await login(EMAIL.emp, TEST_PASSWORD)).status).toBe(423);
  });

  it('the sign-in rate limit applies per IP when enabled', async () => {
    const { login } = await boot({ env: { LOGIN_MAX_ATTEMPTS: 0, LOGIN_RATE_LIMIT_PER_MIN: 3 } });
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await login('nobody', 'x')).status);
    expect(s).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('local test login', () => {
  it('admin / admin exists only when the local test option is on, as a super admin', async () => {
    const on = await boot({ devAdmin: true });
    const r = await on.login(DEV_ADMIN.loginId, DEV_ADMIN.password);
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('SUPER_ADMIN');
    expect((await on.login('ADMIN', 'admin')).status).toBe(200); // login id is case-insensitive
    expect((await on.login('admin', 'wrong')).status).toBe(401);
    const me = await on.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `nutex_session=${r.cookie}` } });
    expect(JSON.parse(me.body).user.employeeId).toBe('E001'); // can punch in as a real employee
    const off = await boot({ devAdmin: false });
    expect((await off.login('admin', 'admin')).status).toBe(401);
  });

  it('the login form accepts a plain username, not just an email', () => {
    expect(loginBody.safeParse({ email: 'admin', password: 'admin' }).success).toBe(true);
    expect(loginBody.safeParse({ email: '  admin ', password: 'x' }).data?.email).toBe('admin');
    expect(loginBody.safeParse({ email: '', password: 'x' }).success).toBe(false);
    expect(loginBody.safeParse({ email: 'a', password: 'x', extra: 1 }).success).toBe(false);
  });

  it('the emulator (and so admin/admin) refuses to run in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await expect(createEmulatorContext({ devAdmin: true })).rejects.toThrow(/production/); } finally { process.env.NODE_ENV = prev; }
  });
});
