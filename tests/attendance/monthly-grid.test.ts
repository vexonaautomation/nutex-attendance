import { beforeAll, describe, expect, it } from 'vitest';
import { autoCloseMonths } from '../../apps/api/src/attendance/monthly';
import { ApiEnv, EMAIL, IDS, makeApi } from '../api-helpers';

let api: ApiEnv;
let root: string, emp: string, hrPune: string;
const CODES = new Set(['', 'P', 'HD', 'A', 'L', 'UL', 'W', 'WP', 'H', 'HP', 'WFH', 'M', 'IN']);

beforeAll(async () => {
  api = await makeApi(); // clock: 29 Sep 2026, month not over
  [root, emp, hrPune] = await Promise.all([EMAIL.root, EMAIL.emp, EMAIL.hrPune].map((e) => api.login(e)));
});

describe('monthly attendance grid', () => {
  it('builds a live grid: one row per employee, one code per day, totals', async () => {
    const r = await api.call(root, 'GET', '/api/attendance/monthly?year=2026&month=9');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: 'live', days: 30, title: 'Sep 2026', complete: false });
    expect(r.body.rows.length).toBeGreaterThan(0);
    for (const row of r.body.rows) {
      expect(row.cells).toHaveLength(30);
      expect(row.cells.every((c: string) => CODES.has(c))).toBe(true);
      expect(row.totals.totalDays).toBe(30);
      expect(row.totals.present).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects a bad month', async () => {
    expect((await api.call(root, 'GET', '/api/attendance/monthly?year=2026&month=13')).status).toBe(400);
  });

  it('an employee only ever sees their own row', async () => {
    const r = await api.call(emp, 'GET', '/api/attendance/monthly?year=2026&month=9');
    expect(r.status).toBe(200);
    expect(r.body.rows.every((x: { employeeId: string }) => x.employeeId === IDS.emp)).toBe(true);
  });

  it('refuses to save a month that is not over', async () => {
    const r = await api.call(root, 'POST', '/api/attendance/monthly/save', { year: 2026, month: 9 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MONTH_NOT_COMPLETE');
  });

  it('the automatic job saves last month into its own tab once the new month has started, and only once', async () => {
    api.clock.set('2026-10-01T06:00:00.000Z'); // 11:30 in Kolkata on 1 Oct
    const made = await autoCloseMonths(api.ctx);
    expect(made?.title).toBe('Sep 2026');
    expect((await api.ctx.repo.gateway.listSheets!()).some((s) => s.title === 'Sep 2026')).toBe(true);
    expect(await autoCloseMonths(api.ctx)).toBeNull();
    const again = await api.call(root, 'POST', '/api/attendance/monthly/save', { year: 2026, month: 9 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SAVED');
  });

  it('the saved month is served from the frozen tab and matches the live grid', async () => {
    const saved = await api.call(root, 'GET', '/api/attendance/monthly?year=2026&month=9');
    expect(saved.body.source).toBe('sheet');
    expect(saved.body.savedAt).toBeTruthy();
    const list = await api.call(root, 'GET', '/api/attendance/monthly/months');
    expect(list.body.find((m: { key: string }) => m.key === '2026-09')?.status).toBe('saved');
    expect(saved.body.rows.length).toBeGreaterThan(0);
    for (const row of saved.body.rows) {
      expect(row.cells).toHaveLength(30);
      expect(row.totals.totalDays).toBe(30);
    }
  });

  it('writes an audit entry', async () => {
    const audit = await api.ctx.repo.find('AUDIT_LOG', (r) => r.action === 'ATTENDANCE_MONTH_SAVED');
    expect(audit.length).toBe(1);
  });

  it('a branch-limited HR cannot save a month and never sees the company-wide tab', async () => {
    api.clock.set('2026-11-02T06:00:00.000Z');
    const r = await api.call(hrPune, 'POST', '/api/attendance/monthly/save', { year: 2026, month: 10 });
    expect(r.status).toBe(403);
    const g = await api.call(hrPune, 'GET', '/api/attendance/monthly?year=2026&month=9');
    expect(g.body.source).toBe('live');
  });
});
