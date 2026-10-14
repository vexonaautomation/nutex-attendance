import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../api-helpers';

let api: ApiEnv;
let emp: string, mgr: string, hr: string;

beforeAll(async () => {
  api = await makeApi({ env: { SESSION_TTL_MIN: 1_000_000 } }); // clock: 2026-09-29 04:00Z = 09:30 IST
  [emp, mgr, hr] = await Promise.all([EMAIL.emp, EMAIL.mgr, EMAIL.hr].map((e) => api.login(e)));
});

describe('self punch', () => {
  it('requires an Idempotency-Key', async () => {
    const r = await api.call(emp, 'POST', '/api/attendance/punch', {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('AUTO check-in uses server time converted to the location timezone', async () => {
    const r = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'AUTO' }, { 'idempotency-key': key() });
    expect(r.status).toBe(200);
    expect(r.body.event.type).toBe('IN');
    expect(r.body.event.at).toBe('2026-09-29T09:30:00'); // 04:00Z in Asia/Kolkata
    expect(r.body.event.method).toBe('WEB');
  });

  it('the same idempotency key never creates a second event (retry / double click)', async () => {
    const k = key();
    api.clock.set('2026-09-29T05:00:00.000Z');
    const a = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'OUT' }, { 'idempotency-key': k });
    const b = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'OUT' }, { 'idempotency-key': k });
    expect(a.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.event.eventId).toBe(a.body.event.eventId);
    const events = await api.ctx.repo.find('ATTENDANCE_EVENTS', (r) => r.employee_id === IDS.emp);
    expect(events).toHaveLength(2);
  });

  it('parallel duplicate submissions still produce exactly one event', async () => {
    api.clock.set('2026-09-30T04:00:00.000Z');
    const k = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => api.call(mgr, 'POST', '/api/attendance/punch', { type: 'IN' }, { 'idempotency-key': k })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const events = await api.ctx.repo.find('ATTENDANCE_EVENTS', (r) => r.employee_id === IDS.mgr);
    expect(events).toHaveLength(1);
  });

  it('daily attendance is formula-derived from the events that were written', async () => {
    const d = await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-29&to=2026-09-29');
    expect(d.status).toBe(200);
    const row = d.body[0];
    expect(row.status).toBe('ABSENT'); // 09:30-10:30 = 60 min, below the 240 min half-day threshold
    expect(row.worked_minutes).toBe(60);
    expect(row.exception_flag).toBe('SHORT_HOURS');
    expect(row.first_in).toBe('2026-09-29T09:30:00');
    expect(row.last_out).toBe('2026-09-29T10:30:00');
    expect(row.late_minutes).toBe(20); // 09:30 vs 09:00 + 10 grace
  });

  it('events are append-only and cannot be edited through any route', async () => {
    const list = await api.call(hr, 'GET', '/api/attendance/events?from=2026-09-29&to=2026-09-29');
    expect(list.status).toBe(200);
    expect((await api.call(hr, 'PATCH', `/api/attendance/events/${list.body[0].eventId}`, { type: 'OUT' })).status).toBe(404);
    await expect(api.ctx.repo.update('ATTENDANCE_EVENTS', list.body[0].eventId, { event_type: 'OUT' })).rejects.toThrow(/append-only/);
  });
});

describe('geofence', () => {
  it('a geofenced branch rejects punches from outside the radius and accepts inside', async () => {
    await api.ctx.repo.update('LOCATIONS', IDS.loc, { geofence_required: 'Y' });
    api.clock.set('2026-09-28T04:00:00.000Z');
    const out = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'IN', geo: { lat: 19.2, lng: 72.9 } }, { 'idempotency-key': key() });
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('GEOFENCE');
    const none = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'IN' }, { 'idempotency-key': key() });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('LOCATION_REQUIRED');
    const inside = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'IN', geo: { lat: 19.0761, lng: 72.8778, accuracy: 15 } }, { 'idempotency-key': key() });
    expect(inside.status).toBe(200);
    expect(inside.body.event.geoStatus).toBe('INSIDE');
    await api.ctx.repo.update('LOCATIONS', IDS.loc, { geofence_required: 'N' });
  });
});

describe('regularisation workflow', () => {
  beforeAll(() => api.clock.set('2026-09-29T12:00:00.000Z'));
  it('employee requests, manager approves, raw punches stay intact, self-approval is impossible', async () => {
    const req = await api.call(emp, 'POST', '/api/attendance/adjustments', { workDate: '2026-09-29', type: 'TIME_CORRECTION', adjustedIn: '2026-09-29T09:00:00', adjustedOut: '2026-09-29T18:00:00', reason: 'Kiosk was down' });
    expect(req.status).toBe(200);
    const id = req.body.adjustment_id;
    expect((await api.call(emp, 'POST', `/api/attendance/adjustments/${id}/decision`, { decision: 'APPROVED' })).status).toBe(403);
    // duplicates while pending are rejected
    expect((await api.call(emp, 'POST', '/api/attendance/adjustments', { workDate: '2026-09-29', type: 'TIME_CORRECTION', adjustedIn: '2026-09-29T09:00:00', reason: 'again' })).status).toBe(409);
    const before = await api.ctx.repo.find('ATTENDANCE_EVENTS', (r) => r.employee_id === IDS.emp);
    const ok = await api.call(mgr, 'POST', `/api/attendance/adjustments/${id}/decision`, { decision: 'APPROVED', note: 'ok' });
    expect(ok.status).toBe(200);
    const day = (await api.call(emp, 'GET', '/api/attendance/me?from=2026-09-29&to=2026-09-29')).body[0];
    expect(day.status).toBe('PRESENT');
    expect(day.worked_minutes).toBe(480);
    const after = await api.ctx.repo.find('ATTENDANCE_EVENTS', (r) => r.employee_id === IDS.emp);
    expect(after.map((e) => e.event_datetime)).toEqual(before.map((e) => e.event_datetime));
    expect((await api.call(mgr, 'POST', `/api/attendance/adjustments/${id}/decision`, { decision: 'REJECTED' })).status).toBe(409);
  });

  it('cannot regularise into the future or a locked period', async () => {
    const fut = await api.call(emp, 'POST', '/api/attendance/adjustments', { workDate: '2026-10-05', type: 'MISSING_PUNCH', adjustedOut: '2026-10-05T18:00:00', reason: 'future' });
    expect(fut.status).toBe(400);
    const lock = await api.call(emp, 'POST', '/api/attendance/adjustments', { workDate: '2026-08-12', type: 'MISSING_PUNCH', adjustedOut: '2026-08-12T18:00:00', reason: 'old month' });
    expect(lock.status).toBe(423);
    expect(lock.body.error.code).toBe('PERIOD_LOCKED');
  });

  it('a punch dated inside a locked period is refused', async () => {
    api.clock.set('2026-08-20T04:00:00.000Z');
    const r = await api.call(emp, 'POST', '/api/attendance/punch', { type: 'IN' }, { 'idempotency-key': key() });
    expect(r.status).toBe(423);
  });
});
