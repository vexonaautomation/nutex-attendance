import { beforeAll, describe, expect, it } from 'vitest';
import { dateTimeToSerial } from '@nutex/sheet-connector';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../api-helpers';
import { Env, daily, makeEnv, punch, scaffold } from '../helpers';

// ------------------------------------------------------------------ formulas: checked in, not yet out

describe('checked in and still working is IN_PROGRESS, not a missing punch', () => {
  let env: Env;
  const setNow = (local: string) => env.repo.update('SYSTEM_CONFIG', 'ATTENDANCE_AS_OF', { value: dateTimeToSerial(local) });

  beforeAll(async () => {
    env = await makeEnv(80, { ATTENDANCE_DAILY: 320, ATTENDANCE_EVENTS: 200 });
    await scaffold(env, '2026-09-01', '2026-09-30');
  });

  it('IN today with the clock a few hours later -> IN_PROGRESS, no exception, no payroll block', async () => {
    await punch(env, IDS.emp, 'IN', '2026-09-22T09:00:00');
    await setNow('2026-09-22T13:00:00');
    const d = await daily(env, IDS.emp, '2026-09-22');
    expect(d.status).toBe('IN_PROGRESS');
    expect(d.missing_punch).toBe(0);
    expect(d.exception_flag).toBeNull();
    expect(d.exception_open).toBe(0);
    expect(d.late_minutes).toBe(0);
  });

  it('the same day becomes a real MISSING_PUNCH once the working window has passed', async () => {
    await setNow('2026-09-23T09:00:00'); // 24 h later > MAX_SEGMENT_HOURS (20)
    const d = await daily(env, IDS.emp, '2026-09-22');
    expect(d.status).toBe('MISSING_PUNCH');
    expect(d.exception_flag).toBe('MISSING_PUNCH');
    expect(d.exception_open).toBe(1);
  });

  it('checking out closes it normally', async () => {
    await punch(env, IDS.emp, 'OUT', '2026-09-22T18:00:00');
    const d = await daily(env, IDS.emp, '2026-09-22');
    expect(d.status).toBe('PRESENT');
    expect(d.exception_flag).toBeNull();
  });

  it('a night shift is IN_PROGRESS the next morning, before the OUT punch', async () => {
    await punch(env, IDS.night, 'IN', '2026-09-24T22:00:00');
    await setNow('2026-09-25T04:00:00');
    expect((await daily(env, IDS.night, '2026-09-24')).status).toBe('IN_PROGRESS');
    await setNow('2026-09-26T04:00:00'); // 30 h after the IN
    expect((await daily(env, IDS.night, '2026-09-24')).status).toBe('MISSING_PUNCH');
  });

  it('a punch "in the future" of the clock is not treated as in progress (clock must lead the punch)', async () => {
    await punch(env, IDS.mgr, 'IN', '2026-09-25T10:00:00');
    await setNow('2026-09-25T09:00:00');
    expect((await daily(env, IDS.mgr, '2026-09-25')).status).toBe('MISSING_PUNCH');
  });

  it('an approved adjustment still resolves a genuine missing punch', async () => {
    await setNow('2026-09-30T09:00:00');
    await punch(env, IDS.hr, 'IN', '2026-09-10T09:00:00');
    expect((await daily(env, IDS.hr, '2026-09-10')).status).toBe('MISSING_PUNCH');
    await env.repo.append('ATTENDANCE_ADJUSTMENTS', { adjustment_id: 'ADJ-IP', employee_id: IDS.hr, work_date: '2026-09-10', adjustment_type: 'MISSING_PUNCH', adjusted_out: '2026-09-10T18:00:00', reason: 'forgot', status: 'APPROVED', company_id: IDS.company });
    expect((await daily(env, IDS.hr, '2026-09-10')).status).toBe('PRESENT');
  });
});

// ------------------------------------------------------------------ API: every punch carries the device location

const HQ = { lat: 19.076, lng: 72.8777 };
let api: ApiEnv;
let emp: string, hr: string, root: string, oper: string;
const fix = (over: Record<string, unknown> = {}) => ({ lat: 19.0761, lng: 72.8778, accuracy: 12, capturedAt: api.clock.now.getTime(), ...over });
const punchReq = (cookie: string, body: Record<string, unknown>, k = key()) => api.call(cookie, 'POST', '/api/attendance/punch', body, { 'idempotency-key': k });
const eventRows = (employeeId: string) => api.ctx.repo.find('ATTENDANCE_EVENTS', (r) => r.employee_id === employeeId);

beforeAll(async () => {
  api = await makeApi({ requireLocation: true }); // clock: 2026-09-29 04:00Z = 09:30 IST
  [emp, hr, root, oper] = await Promise.all([EMAIL.emp, EMAIL.hr, EMAIL.root, EMAIL.oper].map((e) => api.login(e)));
});

describe('the location policy', () => {
  it('is visible to every signed-in user together with their branch', async () => {
    const r = await api.call(emp, 'GET', '/api/attendance/policy');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ requiresLocation: true, maxAccuracyM: 150, branch: { id: IDS.loc, hasCoordinates: true } });
  });

  it('a punch without a location is refused and nothing is written', async () => {
    const r = await punchReq(emp, { type: 'AUTO' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LOCATION_REQUIRED');
    expect(await eventRows(IDS.emp)).toHaveLength(0);
  });

  it('a rough position is refused with the reason, a stale or impossible one too', async () => {
    const rough = await punchReq(emp, { type: 'AUTO', geo: fix({ accuracy: 500 }) });
    expect(rough.status).toBe(422);
    expect(rough.body.error.code).toBe('LOCATION_INACCURATE');
    expect(rough.body.error.message).toMatch(/500 m|about 500/);
    const stale = await punchReq(emp, { type: 'AUTO', geo: fix({ capturedAt: api.clock.now.getTime() - 10 * 60_000 }) });
    expect(stale.body.error.code).toBe('LOCATION_STALE');
    const nowhere = await punchReq(emp, { type: 'AUTO', geo: fix({ lat: 0, lng: 0 }) });
    expect(nowhere.body.error.code).toBe('LOCATION_INVALID');
    expect((await punchReq(emp, { type: 'AUTO', geo: { lat: 91, lng: 0 } })).status).toBe(400);
    expect(await eventRows(IDS.emp)).toHaveLength(0);
  });

  it('LOCATION_MAX_ACCURACY_M is configurable by a super admin (audited, range checked)', async () => {
    expect((await api.call(root, 'PUT', '/api/settings/LOCATION_MAX_ACCURACY_M', { value: 5, reason: 'too strict' })).status).toBe(400);
    expect((await api.call(hr, 'PUT', '/api/settings/LOCATION_MAX_ACCURACY_M', { value: 300, reason: 'not allowed' })).status).toBe(403);
    expect((await api.call(root, 'PUT', '/api/settings/LOCATION_MAX_ACCURACY_M', { value: 600, reason: 'old phones on site' })).status).toBe(200);
    expect((await punchReq(emp, { type: 'AUTO', geo: fix({ accuracy: 500 }) })).status).toBe(200); // now within the limit
    await api.call(root, 'PUT', '/api/settings/LOCATION_MAX_ACCURACY_M', { value: 150, reason: 'back to default' });
    expect((await api.ctx.repo.find('AUDIT_LOG', (a) => a.action === 'SYSTEM_CONFIG_CHANGED' && a.entity_id === 'LOCATION_MAX_ACCURACY_M')).length).toBeGreaterThanOrEqual(2);
    // undo the punch side effect for the tests below: use a fresh employee day by moving the clock
    api.clock.set('2026-09-30T04:00:00.000Z');
  });
});

describe('check-in and check-out both store the coordinates', () => {
  it('the check-in event carries latitude, longitude, accuracy and distance, and the sheet builds a map link', async () => {
    const r = await punchReq(emp, { type: 'AUTO', method: 'MOBILE', geo: fix() });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ type: 'IN', method: 'MOBILE', lat: 19.0761, lng: 72.8778, accuracyM: 12, geoStatus: 'NOT_REQUIRED' });
    expect(r.body.event.distanceM).toBeGreaterThan(0);
    expect(r.body.event.mapUrl).toBe('https://www.google.com/maps?q=19.0761,72.8778');
    const row = (await eventRows(IDS.emp)).find((e) => e.event_id === r.body.event.eventId)!;
    expect(row).toMatchObject({ geo_lat: 19.0761, geo_lng: 72.8778, geo_accuracy: 12, capture_method: 'MOBILE' });
    expect(row.map_url).toBe('https://www.google.com/maps?q=19.0761,72.8778'); // a formula column in the workbook
  });

  it('the check-out stores its own, different coordinates, and the day becomes PRESENT', async () => {
    api.clock.set('2026-09-30T13:30:00.000Z'); // 19:00 IST: a full day after the 09:30 check-in
    const r = await punchReq(emp, { type: 'AUTO', geo: fix({ lat: 19.0765, lng: 72.8781, accuracy: 20 }) });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ type: 'OUT', lat: 19.0765, lng: 72.8781, accuracyM: 20 });
    const events = await api.call(emp, 'GET', '/api/attendance/events?from=2026-09-30&to=2026-09-30');
    expect(events.status).toBe(200);
    expect(events.body.map((e: { type: string }) => e.type).sort()).toEqual(['IN', 'OUT']);
    expect(events.body.every((e: { lat: number | null; lng: number | null }) => e.lat !== null && e.lng !== null)).toBe(true);
    const d = await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-30&to=2026-09-30');
    expect(d.body[0].status).toBe('PRESENT');
  });

  it('HR sees the punches of the branch with employee names; the site clerk too; an employee only their own', async () => {
    const list = await api.call(hr, 'GET', '/api/attendance/events?from=2026-09-30&to=2026-09-30');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
    expect(list.body[0].employeeName).toBe('Chirag Demo');
    expect((await api.call(oper, 'GET', '/api/attendance/events?from=2026-09-30&to=2026-09-30')).status).toBe(200);
  });

  it('the punch is audited with its coordinates', async () => {
    const a = await api.ctx.repo.find('AUDIT_LOG', (x) => x.action === 'ATTENDANCE_EVENT_CREATED');
    expect(String(a[0].after_json)).toContain('geo_lat');
  });

  it('an explicit type that does not match the state is refused (no double check-in)', async () => {
    api.clock.set('2026-10-01T04:00:00.000Z');
    const notIn = await punchReq(emp, { type: 'OUT', geo: fix() });
    expect(notIn.status).toBe(409);
    expect(notIn.body.error.code).toBe('NOT_CHECKED_IN');
    expect((await punchReq(emp, { type: 'IN', geo: fix() })).status).toBe(200);
    const again = await punchReq(emp, { type: 'IN', geo: fix() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CHECKED_IN');
  });

  it('a retried request returns the original event even when its location reading is old by then', async () => {
    api.clock.set('2026-10-02T04:00:00.000Z');
    const k = key();
    const first = await punchReq(hr, { type: 'AUTO', geo: fix() }, k);
    expect(first.status).toBe(200);
    api.clock.set('2026-10-02T04:20:00.000Z'); // 20 minutes later: the fix is stale, but this is a replay
    const again = await punchReq(hr, { type: 'AUTO', geo: fix({ capturedAt: Date.parse('2026-10-02T04:00:00.000Z') }) }, k);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.event.eventId).toBe(first.body.event.eventId);
  });
});

describe('geofence', () => {
  beforeAll(() => api.clock.set('2026-09-28T04:00:00.000Z'));

  it('outside the radius is refused with the distance; inside is accepted and marked INSIDE', async () => {
    await api.ctx.repo.update('LOCATIONS', IDS.loc, { geofence_required: 'Y', geofence_radius_m: 250 });
    const out = await punchReq(emp, { type: 'AUTO', geo: fix({ lat: 19.2, lng: 72.9 }) });
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('GEOFENCE');
    expect(out.body.error.message).toMatch(/\d+ m from .*within 250 m/);
    const inside = await punchReq(emp, { type: 'AUTO', geo: fix() });
    expect(inside.status).toBe(200);
    expect(inside.body.event.geoStatus).toBe('INSIDE');
    expect(inside.body.event.distanceM).toBeLessThan(250);
  });

  it('a geofenced branch without coordinates tells the person to ask the administrator', async () => {
    await api.ctx.repo.update('LOCATIONS', IDS.loc, { latitude: null, longitude: null });
    const r = await punchReq(hr, { type: 'AUTO', geo: fix() });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/no coordinates configured/);
    await api.ctx.repo.update('LOCATIONS', IDS.loc, { latitude: HQ.lat, longitude: HQ.lng, geofence_required: 'N' });
  });
});

describe('when the location rule is switched off', () => {
  it('a punch without coordinates still works and is stored without them', async () => {
    await api.call(root, 'PUT', '/api/settings/PUNCH_REQUIRES_LOCATION', { value: 'N', reason: 'site without signal' });
    api.clock.set('2026-09-27T04:00:00.000Z');
    const r = await punchReq(emp, { type: 'AUTO' });
    expect(r.status).toBe(200);
    expect(r.body.event.lat).toBeNull();
    expect(r.body.event.mapUrl).toBe('');
    await api.call(root, 'PUT', '/api/settings/PUNCH_REQUIRES_LOCATION', { value: 'Y', reason: 'restored' });
    expect((await punchReq(hr, { type: 'AUTO' })).status).toBe(422);
  });
});

describe('manual punch by an administrator', () => {
  beforeAll(() => api.clock.set('2026-09-29T12:00:00.000Z')); // 17:30 IST

  it('records a punch for someone else with a reason: labelled MANUAL, no coordinates, audited', async () => {
    const r = await api.call(root, 'POST', '/api/attendance/manual-punch', { employeeId: IDS.night, type: 'IN', at: '2026-09-29T09:05:00', reason: 'Phone lost, no signal at the gate' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 'IN', method: 'MANUAL', at: '2026-09-29T09:05:00', lat: null });
    expect(String(r.body.notes)).toContain('Phone lost');
    expect((await api.ctx.repo.find('AUDIT_LOG', (a) => a.action === 'ATTENDANCE_MANUAL_PUNCH')).length).toBe(1);
  });

  it('is refused for yourself, for the future, for a duplicate, without a reason and for roles without approval rights', async () => {
    const asRoot = (b: Record<string, unknown>) => api.call(root, 'POST', '/api/attendance/manual-punch', b);
    expect((await asRoot({ employeeId: IDS.hr, type: 'IN', at: '2026-09-29T09:00:00', reason: 'my own punch' })).status).toBe(403); // root is E001
    expect((await asRoot({ employeeId: IDS.night, type: 'OUT', at: '2026-09-30T09:00:00', reason: 'future punch' })).status).toBe(400);
    const dup = await asRoot({ employeeId: IDS.night, type: 'IN', at: '2026-09-29T09:05:00', reason: 'again the same' });
    expect(dup.status).toBe(409);
    expect((await asRoot({ employeeId: IDS.night, type: 'OUT', at: '2026-09-29T17:00:00', reason: 'x' })).status).toBe(400);
    expect((await api.call(emp, 'POST', '/api/attendance/manual-punch', { employeeId: IDS.night, type: 'OUT', at: '2026-09-29T17:00:00', reason: 'not my job' })).status).toBe(403);
    expect((await api.call(oper, 'POST', '/api/attendance/manual-punch', { employeeId: IDS.night, type: 'OUT', at: '2026-09-29T17:00:00', reason: 'clerks cannot' })).status).toBe(403);
  });

  it('cannot reach into a locked payroll period', async () => {
    const r = await api.call(root, 'POST', '/api/attendance/manual-punch', { employeeId: IDS.night, type: 'IN', at: '2026-08-15T09:00:00', reason: 'back-dating into August' });
    expect(r.status).toBe(423);
  });
});
