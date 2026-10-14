import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app';
import { createEmulatorContext } from '../apps/api/src/bootstrap';
import { scaffoldAttendanceDaily } from '../apps/api/src/common/scaffold';
import type { AppContext } from '../apps/api/src/common/core';
import { IDS } from '../google/setup/seed-data';

export { IDS };
/** test-only password for the synthetic demo users (never a real credential) */
export const TEST_PASSWORD = 'Test-Passw0rd-123';

export const EMAIL = {
  hr: 'hr.admin@demo.nutex.example', mgr: 'manager@demo.nutex.example', emp: 'employee@demo.nutex.example', night: 'night.shift@demo.nutex.example',
  fin: 'finance@demo.nutex.example', oper: 'operator@demo.nutex.example', root: 'super.admin@demo.nutex.example', hrPune: 'hr.pune@demo.nutex.example',
};

export interface Clock { now: Date; set(iso: string): void }

export interface ApiEnv {
  app: FastifyInstance;
  ctx: AppContext;
  clock: Clock;
  /** sign in and return a cookie header value */
  login(email: string, password?: string): Promise<string>;
  call(cookie: string | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Record<string, unknown>; raw: Buffer }>;
}

/** `requireLocation: true` keeps the product default (every punch must carry a GPS fix); other tests punch without coordinates for speed */
export async function makeApi(o: { scaffold?: boolean; env?: Record<string, unknown>; start?: string; requireLocation?: boolean } = {}): Promise<ApiEnv> {
  const clock: Clock = { now: new Date(o.start ?? '2026-09-29T04:00:00.000Z'), set(iso) { this.now = new Date(iso); } };
  const { ctx } = await createEmulatorContext({
    rows: 60, big: { ATTENDANCE_EVENTS: 300, ATTENDANCE_DAILY: 400, PAYROLL_INPUTS: 30, PAYROLL_CALC: 30, STATUTORY_CALC: 30, PAYROLL_SNAPSHOT: 60, AUDIT_LOG: 400, ERROR_LOG: 30, NOTIFICATIONS: 60, LEAVE_BALANCES: 150, LEAVE_TRANSACTIONS: 200, LEAVE_APPLICATIONS: 80 },
    password: TEST_PASSWORD, now: () => clock.now, env: { NODE_ENV: 'test', LOGIN_MAX_ATTEMPTS: 5, SESSION_TTL_MIN: 1_000_000, ...o.env },
  });
  if (o.scaffold !== false) await scaffoldAttendanceDaily(ctx.repo, '2026-09-01', '2026-09-30', { companyId: IDS.company, actor: 'test', requestId: 'test', now: '2026-09-01T00:00:00' });
  if (!o.requireLocation) await ctx.repo.update('SYSTEM_CONFIG', 'PUNCH_REQUIRES_LOCATION', { value: 'N' });
  const app = await buildApp(ctx);
  await app.ready();
  const call: ApiEnv['call'] = async (cookie, method, url, body, headers = {}) => {
    const res = await app.inject({
      method, url, payload: body === undefined ? undefined : (body as object),
      headers: { 'x-requested-with': 'nutex', ...(cookie ? { cookie } : {}), ...headers },
    });
    let parsed: any = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.rawPayload };
  };
  return {
    app, ctx, clock, call,
    async login(email, password = TEST_PASSWORD) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-requested-with': 'nutex' } });
      if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.statusCode} ${r.body}`);
      const c = r.cookies.find((x) => x.name === 'nutex_session');
      return `nutex_session=${c!.value}`;
    },
  };
}

let n = 0;
export const key = (p = 'k') => `${p}-test-${++n}-${Math.random().toString(36).slice(2, 8)}`;
