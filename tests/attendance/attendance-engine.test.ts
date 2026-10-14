import { beforeAll, describe, expect, it } from 'vitest';
import { Env, IDS, addLeave, daily, makeEnv, punch, scaffold } from '../helpers';

/**
 * Attendance is 100% formula-derived. These tests write RAW events / inputs and assert on ATTENDANCE_DAILY formula output.
 * Demo calendar: 2026-09-01 is a Tuesday. Sat/Sun weekly off. 2026-09-14 (Mon) is a company holiday.
 */
let env: Env;
beforeAll(async () => {
  env = await makeEnv(80, { ATTENDANCE_DAILY: 320, ATTENDANCE_EVENTS: 200 });
  await scaffold(env, '2026-09-01', '2026-09-30');
});

describe('raw event integrity', () => {
  it('schema has all 44 tabs and formulas evaluate without errors on an empty scaffold', async () => {
    const errs = (await env.repo.readAll('ATTENDANCE_DAILY')).flatMap((r) => Object.entries(r).filter(([, v]) => typeof v === 'string' && v.startsWith('#')));
    expect(errs).toEqual([]);
    expect(env.idx.tabs).toHaveLength(44);
  });
});

describe('daily attendance derived by formulas', () => {
  it('no punch on a working day -> ABSENT, full LOP', async () => {
    const d = await daily(env, IDS.emp, '2026-09-02');
    expect(d.status).toBe('ABSENT');
    expect(d.day_credit).toBe(0);
    expect(d.lop_days).toBe(1);
  });

  it('normal day -> PRESENT, late minutes respect grace', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-03T09:08:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-03T18:00:00');
    const d = await daily(env, IDS.emp, '2026-09-03');
    expect(d.status).toBe('PRESENT');
    expect(d.worked_minutes).toBe(532 - 60);
    expect(d.late_minutes).toBe(0); // 8 min < 10 grace
    expect(d.grace_credit_minutes).toBe(8); // 472 + 8 grace >= 480 -> full day
    expect(d.day_credit).toBe(1);
  });

  it('late beyond grace and early exit are measured in minutes', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-04T09:40:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-04T17:30:00');
    const d = await daily(env, IDS.emp, '2026-09-04');
    expect(d.late_minutes).toBe(30); // 40 - 10 grace
    expect(d.early_minutes).toBe(30);
    expect(d.worked_minutes).toBe(410);
    expect(d.status).toBe('HALF_DAY');
  });

  it('one punch only -> MISSING_PUNCH exception, no credit until resolved', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-08T09:00:00');
    const d = await daily(env, IDS.emp, '2026-09-08');
    expect(d.status).toBe('MISSING_PUNCH');
    expect(d.exception_flag).toBe('MISSING_PUNCH');
    expect(d.exception_open).toBe(1);
    expect(d.day_credit).toBe(0);
  });

  it('duplicate punches inside the window are ignored', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-09T09:00:00');
    await punch(env, IDS.emp, 'IN', '2026-09-09T09:01:00'); // duplicate (60s)
    await punch(env, IDS.emp, 'OUT', '2026-09-09T18:00:00');
    const d = await daily(env, IDS.emp, '2026-09-09');
    expect(d.punch_count).toBe(2);
    expect(d.status).toBe('PRESENT');
    expect(d.first_in).toBe('2026-09-09T09:00:00');
  });

  it('multiple punches (lunch out/in) pair into segments and trust the break punches', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-10T09:00:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-10T13:00:00');
    await punch(env, IDS.emp, 'IN', '2026-09-10T13:45:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-10T18:00:00');
    const d = await daily(env, IDS.emp, '2026-09-10');
    expect(d.seg_count).toBe(2);
    expect(d.worked_minutes).toBe(240 + 255); // no extra break deduction
    expect(d.status).toBe('PRESENT');
  });

  it('half day threshold', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-11T09:00:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-11T14:30:00');
    const d = await daily(env, IDS.emp, '2026-09-11');
    expect(d.worked_minutes).toBe(330 - 60);
    expect(d.status).toBe('HALF_DAY');
    expect(d.day_credit).toBe(0.5);
    expect(d.lop_days).toBe(0.5);
  });

  it('weekly off and holiday without work', async () => {
    expect((await daily(env, IDS.emp, '2026-09-05')).status).toBe('WEEKOFF');
    expect((await daily(env, IDS.emp, '2026-09-14')).status).toBe('HOLIDAY');
    expect((await daily(env, IDS.emp, '2026-09-14')).day_credit).toBe(1);
  });

  it('weekly-off work and holiday work are flagged, credited and OT-eligible', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-12T10:00:00'); // Saturday
    await punch(env, IDS.emp, 'OUT', '2026-09-12T19:00:00');
    const wo = await daily(env, IDS.emp, '2026-09-12');
    expect(wo.status).toBe('WEEKOFF_WORK');
    expect(wo.ot_min_offday).toBe(480);
    expect(wo.comp_off_eligible).toBe(1);

    await punch(env, IDS.emp, 'IN', '2026-09-14T09:00:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-14T15:00:00');
    const h = await daily(env, IDS.emp, '2026-09-14');
    expect(h.status).toBe('HOLIDAY_WORK');
    expect(h.comp_off_eligible).toBe(0.5);
  });

  it('regular-day overtime after threshold for OT-eligible staff only', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-15T09:00:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-15T20:00:00');
    const d = await daily(env, IDS.emp, '2026-09-15');
    expect(d.worked_minutes).toBe(600); // 11h span - 60 break
    expect(d.ot_min_regular).toBe(600 - 480 - 30);
    await punch(env, IDS.mgr, 'IN', '2026-09-15T09:00:00');
    await punch(env, IDS.mgr, 'OUT', '2026-09-15T20:00:00');
    expect((await daily(env, IDS.mgr, '2026-09-15')).ot_min_regular).toBe(0);
  });
});

describe('night and cross-midnight shifts', () => {
  it('22:00 -> 06:00 stays on the IN work date and computes worked minutes across midnight', async () => {
    await punch(env, IDS.night, 'IN', '2026-09-02T21:55:00');
    await punch(env, IDS.night, 'OUT', '2026-09-03T06:05:00');
    const d = await daily(env, IDS.night, '2026-09-02');
    expect(d.first_in).toBe('2026-09-02T21:55:00');
    expect(d.last_out).toBe('2026-09-03T06:05:00');
    expect(d.worked_minutes).toBe(490 - 30);
    expect(d.status).toBe('PRESENT');
    expect(d.late_minutes).toBe(0);
    const next = await daily(env, IDS.night, '2026-09-03');
    expect(next.punch_count).toBe(0);
  });

  it('night minutes and overnight OT are computed by formula', async () => {
    await punch(env, IDS.night, 'IN', '2026-09-08T22:00:00');
    await punch(env, IDS.night, 'OUT', '2026-09-09T08:00:00');
    const d = await daily(env, IDS.night, '2026-09-08');
    expect(d.night_minutes).toBe(480); // 22:00-06:00 window
    expect(d.worked_minutes).toBe(600 - 30);
    expect(d.ot_min_regular).toBe(570 - 450 - 30);
    expect(d.night_ot_minutes).toBe(90);
  });

  it('early-morning OUT paired with a previous-day IN is not counted as a new IN day', async () => {
    const d = await daily(env, IDS.night, '2026-09-09');
    expect(d.punch_count).toBe(0);
  });
});

describe('leave, WFH / OD overriding absence', () => {
  it('approved paid leave overrides absence', async () => {
    await addLeave(env, IDS.emp, IDS.lt.cl, '2026-09-16', '2026-09-16');
    const d = await daily(env, IDS.emp, '2026-09-16');
    expect(d.status).toBe('LEAVE');
    expect(d.day_credit).toBe(1);
    expect(d.lop_days).toBe(0);
  });

  it('pending leave does not override', async () => {
    await addLeave(env, IDS.emp, IDS.lt.cl, '2026-09-17', '2026-09-17', 'PENDING');
    expect((await daily(env, IDS.emp, '2026-09-17')).status).toBe('ABSENT');
  });

  it('unpaid leave (LOP type) gives zero credit', async () => {
    await addLeave(env, IDS.emp, IDS.lt.lop, '2026-09-18', '2026-09-18');
    const d = await daily(env, IDS.emp, '2026-09-18');
    expect(d.status).toBe('UNPAID_LEAVE');
    expect(d.day_credit).toBe(0);
    expect(d.lop_days).toBe(1);
  });

  it('WFH / OD override absence with full credit', async () => {
    await addLeave(env, IDS.emp, IDS.lt.wfh, '2026-09-21', '2026-09-21');
    await addLeave(env, IDS.emp, IDS.lt.od, '2026-09-22', '2026-09-22');
    expect((await daily(env, IDS.emp, '2026-09-21')).status).toBe('WFH_OD');
    expect((await daily(env, IDS.emp, '2026-09-22')).day_credit).toBe(1);
  });

  it('half-day paid leave + half-day worked = full credit', async () => {
    await addLeave(env, IDS.emp, IDS.lt.cl, '2026-09-23', '2026-09-23', 'APPROVED', 'Y');
    await punch(env, IDS.emp, 'IN', '2026-09-23T09:00:00');
    await punch(env, IDS.emp, 'OUT', '2026-09-23T14:30:00');
    const d = await daily(env, IDS.emp, '2026-09-23');
    expect(d.leave_paid_frac).toBe(0.5);
    expect(d.day_credit).toBe(1);
  });

  it('half-day leave with no work -> half credit, half LOP', async () => {
    await addLeave(env, IDS.mgr, IDS.lt.cl, '2026-09-24', '2026-09-24', 'APPROVED', 'Y');
    const d = await daily(env, IDS.mgr, '2026-09-24');
    expect(d.day_credit).toBe(0.5);
    expect(d.lop_days).toBe(0.5);
  });

  it('leave spanning a weekend counts only working days (boundary case)', async () => {
    const app = await addLeave(env, IDS.hr, IDS.lt.cl, '2026-09-25', '2026-09-28');
    expect(app.days_count).toBe(2); // Fri + Mon
    expect((await daily(env, IDS.hr, '2026-09-26')).status).toBe('WEEKOFF');
    expect((await daily(env, IDS.hr, '2026-09-28')).status).toBe('LEAVE');
  });

  it('leave across a holiday excludes the holiday', async () => {
    const app = await addLeave(env, IDS.fin, IDS.lt.cl, '2026-09-11', '2026-09-15');
    expect(app.days_count).toBe(2); // Fri 11 + Tue 15; Sat/Sun weekly off, Mon 14 holiday
  });
});

describe('employment window', () => {
  it('mid-month joiner has no attendance rows before joining; leaver none after exit', async () => {
    const rows = await env.repo.readAll('ATTENDANCE_DAILY');
    expect(rows.some((r) => r.employee_id === IDS.joiner && String(r.work_date) < '2026-09-16')).toBe(false);
    expect(rows.some((r) => r.employee_id === IDS.leaver && String(r.work_date) > '2026-09-20')).toBe(false);
    expect(rows.some((r) => r.employee_id === IDS.leaver && r.work_date === '2026-09-20')).toBe(true);
  });
});

describe('adjustments never overwrite raw punches', () => {
  it('approved adjustment supplies the missing OUT while raw event stays untouched', async () => {
    const before = await env.repo.readAll('ATTENDANCE_EVENTS');
    await env.repo.append('ATTENDANCE_ADJUSTMENTS', {
      adjustment_id: 'ADJ-1', employee_id: IDS.emp, work_date: '2026-09-08', adjustment_type: 'MISSING_PUNCH', adjusted_out: '2026-09-08T18:00:00',
      original_first_in: '2026-09-08T09:00:00', reason: 'Forgot to punch out', requested_by: 'U003', status: 'PENDING', company_id: IDS.company,
    });
    expect((await daily(env, IDS.emp, '2026-09-08')).status).toBe('MISSING_PUNCH'); // pending has no effect
    await env.repo.update('ATTENDANCE_ADJUSTMENTS', 'ADJ-1', { status: 'APPROVED', decided_by: 'U002', decided_at: '2026-09-09T10:00:00' });
    const d = await daily(env, IDS.emp, '2026-09-08');
    expect(d.status).toBe('PRESENT');
    expect(d.worked_minutes).toBe(540 - 60);
    expect(d.exception_open).toBe(0);
    const after = await env.repo.readAll('ATTENDANCE_EVENTS');
    expect(after.length).toBe(before.length);
    expect(after.find((e) => e.employee_id === IDS.emp && e.event_datetime === '2026-09-08T09:00:00')?.event_type).toBe('IN');
  });

  it('raw event rows cannot be updated', async () => {
    await expect(env.repo.update('ATTENDANCE_EVENTS', 'EV-00001', { event_type: 'OUT' })).rejects.toThrow(/append-only/);
  });
});
