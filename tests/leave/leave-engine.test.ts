import { beforeAll, describe, expect, it } from 'vitest';
import { Env, IDS, addLeave, makeEnv } from '../helpers';

let env: Env;
const bal = async (emp: string, type: string) => {
  const r = await env.repo.findOne('LEAVE_BALANCES', (x) => x.balance_key === `${emp}:${type}:2026`);
  if (!r) throw new Error('no balance row');
  return r;
};
const txn = (n: number, emp: string, type: string, kind: string, days: number) =>
  env.repo.append('LEAVE_TRANSACTIONS', {
    txn_id: `LTX-T${n}`, employee_id: emp, leave_type_id: type, leave_year: 2026, txn_type: kind, txn_date: '2026-09-30', days, idempotency_key: `t${n}`,
    company_id: IDS.company, created_at: '2026-09-30T00:00:00', created_by: 'test', request_id: `t${n}`, status: 'ACTIVE',
  });

beforeAll(async () => { env = await makeEnv(60); });

describe('accrual is calculated in the sheet, posted through the ledger', () => {
  it('monthly accrual (permanent, 1/month, as-of 2026-09-30) = 9 months and is pending until posted', async () => {
    const b = await bal(IDS.hr, IDS.lt.cl);
    expect(b.months_elapsed).toBe(9);
    expect(b.accrual_target).toBe(9);
    expect(b.accrual_pending).toBe(9);
    expect(b.balance).toBe(0);
  });

  it('posting the ACCRUAL transaction moves the balance and clears accrual_pending', async () => {
    await txn(1, IDS.hr, IDS.lt.cl, 'ACCRUAL', 9);
    const b = await bal(IDS.hr, IDS.lt.cl);
    expect(b.balance).toBe(9);
    expect(b.accrual_pending).toBe(0);
    expect(b.credited).toBe(9);
  });

  it('annual upfront (sick leave) credits the quota', async () => {
    expect((await bal(IDS.hr, IDS.lt.sl)).accrual_target).toBe(12);
  });

  it('probationer: pro-rata by joining month, probation lock blocks earned leave', async () => {
    const cl = await bal(IDS.joiner, IDS.lt.cl);
    expect(cl.accrual_target).toBe(0.5); // joined 16 Sep -> 1 month x 0.5
    const sl = await bal(IDS.joiner, IDS.lt.sl);
    expect(sl.accrual_target).toBe(2); // 6 x (12-8)/12 = 2, rounded to 0.5
    const el = await bal(IDS.joiner, IDS.lt.el);
    expect(el.accrual_target).toBe(0); // eligible only after probation_end_date
  });

  it('earned leave: carry-forward and encashment caps come from the policy', async () => {
    await txn(2, IDS.hr, IDS.lt.el, 'ACCRUAL', 13.5); // + OPENING 6 from seed
    const b = await bal(IDS.hr, IDS.lt.el);
    expect(b.balance).toBe(19.5);
    expect(b.carry_forward_eligible).toBe(19.5);
    expect(b.encashable_days).toBe(15);
  });
});

describe('applications, holds and balance checks', () => {
  it('pending application reduces available balance but not the ledger balance', async () => {
    const before = await bal(IDS.hr, IDS.lt.cl);
    const app = await addLeave(env, IDS.hr, IDS.lt.cl, '2026-10-05', '2026-10-06', 'PENDING'); // Mon-Tue
    expect(app.days_count).toBe(2);
    expect(app.balance_check).toBe('OK');
    const after = await bal(IDS.hr, IDS.lt.cl);
    expect(after.balance).toBe(before.balance);
    expect(after.pending_approval).toBe(2);
    expect(after.available).toBe((before.balance as number) - 2);
  });

  it('insufficient balance is flagged; negative balance only where the type allows it', async () => {
    const big = await addLeave(env, IDS.hr, IDS.lt.cl, '2026-11-02', '2026-11-27', 'PENDING'); // 20 working days > 9
    expect(big.balance_check).toBe('INSUFFICIENT');
    const lop = await addLeave(env, IDS.hr, IDS.lt.lop, '2026-11-02', '2026-11-03', 'PENDING');
    expect(['OK', 'NEGATIVE_ALLOWED']).toContain(lop.balance_check);
  });

  it('overlap with another active application is detected', async () => {
    const dup = await addLeave(env, IDS.hr, IDS.lt.cl, '2026-10-06', '2026-10-07', 'PENDING');
    expect(dup.overlap_count).toBeGreaterThanOrEqual(1);
  });

  it('approval + LEAVE_TAKEN debit is the only way the balance falls', async () => {
    const before = await bal(IDS.hr, IDS.lt.cl);
    await txn(3, IDS.hr, IDS.lt.cl, 'LEAVE_TAKEN', -2);
    const after = await bal(IDS.hr, IDS.lt.cl);
    expect(after.balance).toBe((before.balance as number) - 2);
    expect(after.debited).toBe(2);
  });

  it('a debit that would go negative for a type that forbids it raises negative_flag', async () => {
    await txn(4, IDS.hr, IDS.lt.cl, 'LEAVE_TAKEN', -20);
    expect((await bal(IDS.hr, IDS.lt.cl)).negative_flag).toBe(1);
  });

  it('ledger sign mismatches are surfaced', async () => {
    const bad = await txn(5, IDS.mgr, IDS.lt.cl, 'LEAVE_TAKEN', 1);
    expect(bad.sign_check).toBe('SIGN_MISMATCH');
    const ok = await txn(6, IDS.mgr, IDS.lt.cl, 'ADJUSTMENT_CREDIT', 1);
    expect(ok.sign_check).toBe('OK');
  });

  it('the ledger is append-only', async () => {
    await expect(env.repo.update('LEAVE_TRANSACTIONS', 'LTX-T1', { days: 100 })).rejects.toThrow(/append-only/);
  });
});
