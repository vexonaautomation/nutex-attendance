import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../api-helpers';

let api: ApiEnv;
let emp: string, mgr: string, hr: string;
const bal = async (e: string, t: string) => (await api.ctx.repo.findOne('LEAVE_BALANCES', (r) => r.balance_key === `${e}:${t}:2026`))!;

beforeAll(async () => {
  api = await makeApi(); // 2026-09-29
  [emp, mgr, hr] = await Promise.all([EMAIL.emp, EMAIL.mgr, EMAIL.hr].map((e) => api.login(e)));
});

describe('leave application and approval', () => {
  it('is auto-cancelled when the sheet formulas say the balance is insufficient', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-30', toDate: '2026-09-30', halfDay: 'N', reason: 'trip' }, { 'idempotency-key': key() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const rows = await api.ctx.repo.find('LEAVE_APPLICATIONS', (x) => x.employee_id === IDS.emp);
    expect(rows[0].status).toBe('CANCELLED'); // never deleted: the attempt stays auditable
  });

  it('accrual job posts the sheet-calculated amount once (idempotent)', async () => {
    const a = await api.call(hr, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' });
    expect(a.status).toBe(200);
    expect(a.body.posted).toBeGreaterThan(0);
    expect((await bal(IDS.emp, IDS.lt.cl)).balance).toBe(9);
    const again = await api.call(hr, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' });
    expect(again.body.posted).toBe(0);
    expect((await bal(IDS.emp, IDS.lt.cl)).balance).toBe(9);
  });

  it('employees cannot run accruals', async () => {
    expect((await api.call(emp, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' })).status).toBe(403);
  });

  let appId = '';
  it('a valid application is PENDING and holds balance without touching the ledger', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-30', toDate: '2026-09-30', halfDay: 'N', reason: 'family' }, { 'idempotency-key': key() });
    expect(r.status).toBe(200);
    expect(r.body.application.status).toBe('PENDING');
    expect(r.body.application.days_count).toBe(1);
    appId = r.body.application.application_id;
    const b = await bal(IDS.emp, IDS.lt.cl);
    expect(b.balance).toBe(9);
    expect(b.pending_approval).toBe(1);
    expect(b.available).toBe(8);
  });

  it('replaying the same request does not create a second application', async () => {
    const k = key();
    const a = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.sl, fromDate: '2026-10-07', toDate: '2026-10-07', halfDay: 'N', reason: 'x' }, { 'idempotency-key': k });
    const b = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.sl, fromDate: '2026-10-07', toDate: '2026-10-07', halfDay: 'N', reason: 'x' }, { 'idempotency-key': k });
    expect(b.body.replayed).toBe(true);
    expect(b.body.application.application_id).toBe(a.body.application.application_id);
  });

  it('overlapping applications are rejected', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-30', toDate: '2026-10-01', halfDay: 'N', reason: 'again' }, { 'idempotency-key': key() });
    expect(r.status).toBe(409);
  });

  it('nobody approves their own leave; the manager can', async () => {
    expect((await api.call(emp, 'POST', `/api/leave/applications/${appId}/decision`, { decision: 'APPROVED' })).status).toBe(403);
    const ok = await api.call(mgr, 'POST', `/api/leave/applications/${appId}/decision`, { decision: 'APPROVED', note: 'enjoy' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
  });

  it('approval posts a LEAVE_TAKEN ledger row; the balance falls only through it', async () => {
    const tx = await api.ctx.repo.find('LEAVE_TRANSACTIONS', (r) => r.reference_id === appId);
    expect(tx).toHaveLength(1);
    expect(tx[0].txn_type).toBe('LEAVE_TAKEN');
    expect(tx[0].days).toBe(-1);
    const b = await bal(IDS.emp, IDS.lt.cl);
    expect(b.balance).toBe(8);
    expect(b.pending_approval).toBe(0);
  });

  it('approved leave overrides absence in the daily attendance formulas', async () => {
    const d = await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-30&to=2026-09-30');
    expect(d.body[0].status).toBe('LEAVE');
    expect(d.body[0].day_credit).toBe(1);
  });

  it('a second decision is refused', async () => {
    expect((await api.call(mgr, 'POST', `/api/leave/applications/${appId}/decision`, { decision: 'REJECTED' })).status).toBe(409);
  });

  it('cancelling approved future leave writes a reversal and restores the balance', async () => {
    const c = await api.call(emp, 'POST', `/api/leave/applications/${appId}/cancel`, { note: 'plans changed' });
    expect(c.status).toBe(200);
    expect((await bal(IDS.emp, IDS.lt.cl)).balance).toBe(9);
    const tx = await api.ctx.repo.find('LEAVE_TRANSACTIONS', (r) => r.reference_id === appId);
    expect(tx.map((t) => t.txn_type).sort()).toEqual(['LEAVE_REVERSAL', 'LEAVE_TAKEN']);
    expect((await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-30&to=2026-09-30')).body[0].status).toBe('ABSENT');
  });

  it('WFH needs approval but consumes no balance', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.wfh, fromDate: '2026-09-30', toDate: '2026-09-30', halfDay: 'N', reason: 'wfh' }, { 'idempotency-key': key() });
    expect(r.status).toBe(200);
    await api.call(mgr, 'POST', `/api/leave/applications/${r.body.application.application_id}/decision`, { decision: 'APPROVED' });
    expect((await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-30&to=2026-09-30')).body[0].status).toBe('WFH_OD');
    expect((await bal(IDS.emp, IDS.lt.cl)).balance).toBe(9);
    expect(await api.ctx.repo.find('LEAVE_TRANSACTIONS', (t) => t.reference_id === r.body.application.application_id)).toHaveLength(0);
  });

  it('cannot apply into a locked payroll period', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-08-12', toDate: '2026-08-12', halfDay: 'N', reason: 'retro' }, { 'idempotency-key': key() });
    expect(r.status).toBe(423);
  });

  it('half day is only for single days', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-10-08', toDate: '2026-10-09', halfDay: 'Y', reason: 'x' }, { 'idempotency-key': key() });
    expect(r.status).toBe(400);
  });

  it('an employee cannot apply on behalf of a colleague', async () => {
    const r = await api.call(emp, 'POST', '/api/leave/applications', { employeeId: IDS.hr, leaveTypeId: IDS.lt.cl, fromDate: '2026-10-12', toDate: '2026-10-12', halfDay: 'N', reason: 'x' }, { 'idempotency-key': key() });
    expect(r.status).toBe(403);
  });
});

describe('year end', () => {
  it('carries forward within the policy cap and is idempotent', async () => {
    await api.call(hr, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' });
    const r = await api.call(hr, 'POST', '/api/leave/year-end', { year: 2026 });
    expect(r.status).toBe(200);
    const cf = await api.ctx.repo.find('LEAVE_TRANSACTIONS', (t) => t.txn_type === 'CARRY_FORWARD' && t.employee_id === IDS.hr && t.leave_type_id === IDS.lt.el);
    expect(cf).toHaveLength(1);
    expect(cf[0].leave_year).toBe(2027);
    expect(cf[0].days).toBe(19.5); // 6 opening + 13.5 accrued, cap 30
    await api.call(hr, 'POST', '/api/leave/year-end', { year: 2026 });
    expect(await api.ctx.repo.find('LEAVE_TRANSACTIONS', (t) => t.txn_type === 'CARRY_FORWARD' && t.employee_id === IDS.hr && t.leave_type_id === IDS.lt.el)).toHaveLength(1);
  });

  it('encashment is capped by the policy', async () => {
    const tooMany = await api.call(hr, 'POST', '/api/leave/encash', { employeeId: IDS.hr, leaveTypeId: IDS.lt.el, year: 2026, days: 16 });
    expect(tooMany.status).toBe(422);
  });
});
