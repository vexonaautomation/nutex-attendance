import type { GeoStatus } from '@nutex/types';
import type { ManualPunchBody, PunchBody } from '@nutex/validation';
import type { Row } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, haversineMeters, notFound, str, toLocalWallClock, wallClockToDate } from '../common/core';
import { assertNotLocked, isoDatePart } from '../common/period';
import { authorize, empRef, requireEmployeeAccess, scopeAllows, scopedEmployeeIds } from '../auth/auth';
import { scaffoldAttendanceDaily } from '../common/scaffold';
import { dateTimeToSerial, dateToSerial } from '@nutex/sheet-connector';


// ------------------------------------------------------------------ clock + location policy

const lastClockSync = new WeakMap<AppContext, { at: number; value: string }>();

/**
 * The attendance formulas never call TODAY(): they read ATTENDANCE_AS_OF from SYSTEM_CONFIG. The API keeps it equal to the
 * company-local time so that "checked in, not yet out" shows as IN_PROGRESS instead of a missing punch.
 * `force` (used before writing a punch) always refreshes; reads refresh at most every 5 minutes.
 */
export async function syncAttendanceClock(ctx: AppContext, force = false): Promise<void> {
  const now = ctx.now();
  const prev = lastClockSync.get(ctx);
  if (!force && prev && now.getTime() - prev.at < 300_000) return;
  const local = toLocalWallClock(now, ctx.env.COMPANY_TIMEZONE);
  if (prev?.value === local && force) return;
  const stamp = toLocalWallClock(now, ctx.env.COMPANY_TIMEZONE);
  // one write call for both settings
  await ctx.repo.updateMany('SYSTEM_CONFIG', [
    { key: 'ATTENDANCE_AS_OF', patch: { value: dateTimeToSerial(stamp), updated_at: stamp, updated_by: 'SYSTEM' } },
    { key: 'DASHBOARD_DATE', patch: { value: dateToSerial(stamp.slice(0, 10)), updated_at: stamp, updated_by: 'SYSTEM' } },
  ]);
  lastClockSync.set(ctx, { at: now.getTime(), value: stamp });
}

export interface LocationPolicy { required: boolean; maxAccuracyM: number; maxAgeSec: number }

/** how strictly a check-in / check-out must prove where it happened (SYSTEM_CONFIG) */
export async function locationPolicy(ctx: AppContext): Promise<LocationPolicy> {
  const cfg = await ctx.systemConfig();
  return { required: cfg.yn('PUNCH_REQUIRES_LOCATION'), maxAccuracyM: cfg.num('LOCATION_MAX_ACCURACY_M', 150), maxAgeSec: cfg.num('LOCATION_MAX_AGE_SEC', 300) };
}

/** what the check-in screen needs: the rules, and the employee's branch (so it can say "within 250 m of HQ") */
export async function attendancePolicy(ctx: AppContext, actor: Actor) {
  const p = await locationPolicy(ctx);
  const emp = await ctx.repo.getByKey('EMPLOYEES', actor.user.employeeId);
  const loc = emp ? await ctx.repo.getByKey('LOCATIONS', str(emp.location_id)) : null;
  return {
    requiresLocation: p.required, maxAccuracyM: p.maxAccuracyM,
    branch: loc ? { id: str(loc.location_id), name: str(loc.name), geofenceRequired: loc.geofence_required === 'Y', radiusM: Number(loc.geofence_radius_m ?? 0) || null, hasCoordinates: hasCentre(loc) } : null,
  };
}

async function activeEmployee(ctx: AppContext, employeeId: string, localDate: string): Promise<Row> {
  const e = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  if (!e) throw notFound('Employee not found');
  const join = str(e.date_of_joining);
  const exit = str(e.date_of_exit);
  if (e.status !== 'ACTIVE' || (join && localDate < join) || (exit && localDate > exit)) throw new HttpError(422, 'EMPLOYEE_NOT_IN_SERVICE', 'Employee is not in service on this date');
  return e;
}

/** which punch comes next: purely sequencing (last event of the employee inside the segment window) */
async function nextType(ctx: AppContext, employeeId: string, nowLocal: string): Promise<'IN' | 'OUT'> {
  const cfg = await ctx.systemConfig();
  const events = (await ctx.repo.readAll('ATTENDANCE_EVENTS')).filter((r) => r.employee_id === employeeId && r.is_dup !== 1);
  const last = events.sort((a, b) => str(a.event_datetime).localeCompare(str(b.event_datetime))).pop();
  if (!last) return 'IN';
  const hours = (Date.parse(`${nowLocal}Z`) - Date.parse(`${str(last.event_datetime)}Z`)) / 3_600_000;
  if (hours > cfg.num('MAX_SEGMENT_HOURS', 20)) return 'IN';
  return last.event_type === 'IN' ? 'OUT' : 'IN';
}

export interface WriteEventInput {
  employeeId: string; type: 'IN' | 'OUT'; method: 'WEB' | 'MOBILE' | 'MANUAL'; deviceId?: string; localDateTime: string; utcIso: string;
  geo?: { lat: number; lng: number; accuracy?: number }; geoStatus: GeoStatus; distanceM?: number; idempotencyKey: string; notes?: string; eventId?: string;
}

/** the only writer of ATTENDANCE_EVENTS. Append-only, idempotent, period-lock aware. */
export async function writeEvent(ctx: AppContext, actor: Actor, i: WriteEventInput): Promise<{ row: Row; created: boolean }> {
  await assertNotLocked(ctx, isoDatePart(i.localDateTime), 'This punch');
  await syncAttendanceClock(ctx, true);
  const id = i.eventId ?? ctx.id('EV');
  const { row, created } = await ctx.repo.appendIfAbsent('ATTENDANCE_EVENTS', 'idempotency_key', {
    event_id: id, employee_id: i.employeeId, event_datetime: i.localDateTime, event_datetime_utc: i.utcIso, event_type: i.type, capture_method: i.method, device_id: i.deviceId,
    geo_lat: i.geo?.lat, geo_lng: i.geo?.lng, geo_accuracy: i.geo?.accuracy, geo_status: i.geoStatus, geo_distance_m: i.distanceM,
    idempotency_key: i.idempotencyKey, ...auditCols(ctx, actor), notes: i.notes,
  });
  if (created) {
    // the day row and the audit entry live in different tabs: write them at the same time
    await Promise.all([
      ensureDailyRow(ctx, actor, i.employeeId, i.localDateTime),
      ctx.audit.write(actor, {
        action: 'ATTENDANCE_EVENT_CREATED', entityType: 'ATTENDANCE_EVENT', entityId: str(row.event_id),
        after: { employee_id: i.employeeId, type: i.type, at: i.localDateTime, method: i.method, geo_lat: i.geo?.lat, geo_lng: i.geo?.lng, geo_accuracy: i.geo?.accuracy, geo_status: i.geoStatus },
      }),
    ]);
  }
  return { row, created };
}

/**
 * The sheet derives a day only for rows that exist (ATTENDANCE_DAILY is scaffolded per employee and date). Payroll scaffolds a whole
 * period when it is opened; this makes sure a live punch is never left without its day row in between.
 */
async function ensureDailyRow(ctx: AppContext, actor: Actor, employeeId: string, localDateTime: string): Promise<void> {
  const boundary = (await ctx.systemConfig()).num('DAY_BOUNDARY_HOURS', 4);
  const workDate = new Date(Date.parse(`${localDateTime}Z`) - boundary * 3_600_000).toISOString().slice(0, 10);
  const attendanceId = `AD-${employeeId}-${workDate}`;
  // appendIfAbsent is atomic per tab: two simultaneous punches can never create the same day twice
  await ctx.repo.appendIfAbsent('ATTENDANCE_DAILY', 'attendance_id', {
    attendance_id: attendanceId, employee_id: employeeId, work_date: workDate, company_id: actor.user.companyId,
    created_at: toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE), created_by: actor.user.userId, request_id: actor.requestId, status_flag: 'ACTIVE',
  });
}

const hasCentre = (l: Row | null | undefined): boolean => !!l && str(l.latitude) !== '' && str(l.longitude) !== '' && Number.isFinite(Number(l.latitude)) && Number.isFinite(Number(l.longitude));

/** distance to the branch and whether it satisfies the branch geofence */
export function geoCheck(location: Row | undefined | null, geo?: { lat: number; lng: number }): { status: GeoStatus; distanceM?: number; radiusM?: number } {
  const centre = hasCentre(location);
  const distanceM = geo && centre ? Math.round(haversineMeters(geo, { lat: Number(location!.latitude), lng: Number(location!.longitude) })) : undefined;
  if (!location || location.geofence_required !== 'Y') return { status: 'NOT_REQUIRED', distanceM };
  const radiusM = Number(location.geofence_radius_m ?? 0);
  if (!geo || !centre) return { status: 'UNKNOWN', radiusM };
  return { status: distanceM! <= radiusM ? 'INSIDE' : 'OUTSIDE', distanceM, radiusM };
}

/** validate a device location fix against the policy; throws a 422 the UI can show verbatim */
function assertUsableFix(policy: LocationPolicy, geo: PunchBody['geo'], nowMs: number): void {
  if (!geo) {
    if (policy.required) throw new HttpError(422, 'LOCATION_REQUIRED', 'Your location is required to check in or out. Allow location access in the browser and try again.');
    return;
  }
  if (geo.lat === 0 && geo.lng === 0) throw new HttpError(422, 'LOCATION_INVALID', 'The device reported an invalid location (0, 0). Turn location on and try again.');
  if (geo.accuracy !== undefined && geo.accuracy > policy.maxAccuracyM) {
    throw new HttpError(422, 'LOCATION_INACCURATE', `Your location is not accurate enough (about ${Math.round(geo.accuracy)} m, limit ${policy.maxAccuracyM} m). Turn on precise location / GPS, step outside or near a window, and try again.`);
  }
  if (geo.capturedAt !== undefined && Math.abs(nowMs - geo.capturedAt) > policy.maxAgeSec * 1000) {
    throw new HttpError(422, 'LOCATION_STALE', 'Your location reading is out of date. Check that the phone clock is correct, then try again.');
  }
}

/** employee self check-in / check-out. Every punch carries the device location, which is stored with the event. */
export async function selfPunch(ctx: AppContext, actor: Actor, body: PunchBody, idempotencyKey: string | undefined) {
  if (!idempotencyKey || idempotencyKey.length < 8) throw badRequest('Idempotency-Key header (min 8 chars) is required for punches', 'IDEMPOTENCY_KEY_REQUIRED');
  await authorize(ctx, actor.user, 'attendance', 'write');
  const employeeId = actor.user.employeeId;
  const key = `${actor.user.userId}:${idempotencyKey}`;
  // a retried request (dropped connection) must return the original event, not fail on a now-stale location
  const prior = await ctx.repo.findOne('ATTENDANCE_EVENTS', (r) => r.idempotency_key === key);
  if (prior) return { replayed: true, event: shapeEvent(prior) };

  const emp = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  if (!emp) throw notFound('Employee record not found');
  const loc = await ctx.repo.getByKey('LOCATIONS', str(emp.location_id));
  const tz = str(loc?.timezone) || ctx.env.COMPANY_TIMEZONE;
  const now = ctx.now();
  const local = toLocalWallClock(now, tz);
  await activeEmployee(ctx, employeeId, isoDatePart(local));

  assertUsableFix(await locationPolicy(ctx), body.geo, now.getTime());
  const check = geoCheck(loc, body.geo);
  if (check.status === 'OUTSIDE') throw new HttpError(403, 'GEOFENCE', `You are about ${check.distanceM} m from ${str(loc?.name) || 'your branch'}; check-in is allowed within ${check.radiusM} m.`);
  if (check.status === 'UNKNOWN') throw new HttpError(422, 'LOCATION_REQUIRED', hasCentre(loc) ? 'Your location is required for this branch. Allow location access and try again.' : 'This branch has no coordinates configured yet. Ask your administrator to set them under Branches.');

  const expected = await nextType(ctx, employeeId, local);
  if (body.type !== 'AUTO' && body.type !== expected) {
    throw conflict(expected === 'OUT' ? 'You are already checked in. Use Check out.' : 'You are not checked in. Use Check in.', expected === 'OUT' ? 'ALREADY_CHECKED_IN' : 'NOT_CHECKED_IN');
  }
  const { row, created } = await writeEvent(ctx, actor, {
    employeeId, type: expected, method: body.method, deviceId: body.deviceId, localDateTime: local, utcIso: now.toISOString(), geo: body.geo, geoStatus: check.status, distanceM: check.distanceM,
    idempotencyKey: key,
  });
  return { replayed: !created, event: shapeEvent(row) };
}

/** an administrator records a punch for someone who could not check in (lost phone, no signal ...). No location, always a reason, always audited. */
export async function manualPunch(ctx: AppContext, actor: Actor, b: ManualPunchBody) {
  await requireEmployeeAccess(ctx, actor, 'attendance', 'approve', b.employeeId);
  if (b.employeeId === actor.user.employeeId) throw forbidden('You cannot record attendance for yourself. Ask another administrator.');
  const norm = b.at.replace(' ', 'T');
  const at = norm.length === 16 ? `${norm}:00` : norm;
  const nowLocal = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  if (at > nowLocal) throw badRequest('A manual punch cannot be in the future');
  await activeEmployee(ctx, b.employeeId, isoDatePart(at));
  const { row, created } = await writeEvent(ctx, actor, {
    employeeId: b.employeeId, type: b.type, method: 'MANUAL', localDateTime: at, utcIso: wallClockToDate(at, ctx.env.COMPANY_TIMEZONE).toISOString(), geoStatus: 'NOT_REQUIRED',
    idempotencyKey: `manual:${b.employeeId}:${b.type}:${at}`, notes: `Manual punch by ${actor.user.userId}: ${b.reason}`,
  });
  if (!created) throw conflict('This punch was already recorded', 'DUPLICATE_PUNCH');
  await ctx.audit.write(actor, { action: 'ATTENDANCE_MANUAL_PUNCH', entityType: 'ATTENDANCE_EVENT', entityId: str(row.event_id), after: { employee_id: b.employeeId, type: b.type, at }, reason: b.reason });
  return shapeEvent(row);
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function shapeEvent(r: Row) {
  const lat = numOrNull(r.geo_lat);
  const lng = numOrNull(r.geo_lng);
  return {
    eventId: r.event_id, employeeId: r.employee_id, at: r.event_datetime, type: r.event_type, method: r.capture_method, workDate: r.work_date,
    geoStatus: r.geo_status, lat, lng, accuracyM: numOrNull(r.geo_accuracy), distanceM: numOrNull(r.geo_distance_m),
    mapUrl: str(r.map_url) || (lat !== null && lng !== null ? `https://www.google.com/maps?q=${lat},${lng}` : ''), notes: str(r.notes) || undefined,
  };
}

export async function listDaily(ctx: AppContext, actor: Actor, q: { from: string; to: string; employeeId?: string }) {
  await syncAttendanceClock(ctx);
  const ids = await scopedEmployeeIds(ctx, actor.user, 'attendance', 'read');
  if (q.employeeId && ids !== 'ALL' && !ids.has(q.employeeId)) throw forbidden();
  const rows = await ctx.repo.find('ATTENDANCE_DAILY', (r) => {
    const d = str(r.work_date);
    if (d < q.from || d > q.to) return false;
    if (q.employeeId) return r.employee_id === q.employeeId;
    return ids === 'ALL' || ids.has(str(r.employee_id));
  });
  return rows.sort((a, b) => str(a.work_date).localeCompare(str(b.work_date)) || str(a.employee_id).localeCompare(str(b.employee_id)));
}

/** raw punches (with their coordinates) in the caller's scope, newest first, with the employee name for display */
export async function listEvents(ctx: AppContext, actor: Actor, q: { from: string; to: string; employeeId?: string }) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'attendance_events', 'read');
  if (q.employeeId && ids !== 'ALL' && !ids.has(q.employeeId)) throw forbidden();
  const rows = await ctx.repo.find('ATTENDANCE_EVENTS', (r) => {
    const d = isoDatePart(str(r.event_datetime));
    if (d < q.from || d > q.to) return false;
    if (q.employeeId) return r.employee_id === q.employeeId;
    return ids === 'ALL' || ids.has(str(r.employee_id));
  });
  const names = new Map((await ctx.repo.readAll('EMPLOYEES')).map((e) => [str(e.employee_id), str(e.full_name) || `${str(e.first_name)} ${str(e.last_name)}`.trim()]));
  return rows
    .sort((a, b) => str(b.event_datetime).localeCompare(str(a.event_datetime)))
    .map((r) => ({ ...shapeEvent(r), employeeName: names.get(str(r.employee_id)) ?? str(r.employee_id) }));
}

// ------------------------------------------------------------------ adjustments (regularisation)

export async function requestAdjustment(ctx: AppContext, actor: Actor, b: { workDate: string; type: string; adjustedIn?: string; adjustedOut?: string; reason: string; employeeId?: string }) {
  const employeeId = b.employeeId ?? actor.user.employeeId;
  const emp = await requireEmployeeAccess(ctx, actor, 'adjustments', 'write', employeeId);
  void emp;
  await assertNotLocked(ctx, b.workDate, 'This regularisation');
  for (const t of [b.adjustedIn, b.adjustedOut]) if (t && isoDatePart(t) > toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE).slice(0, 10)) throw badRequest('Adjusted time cannot be in the future');
  const dup = await ctx.repo.findOne('ATTENDANCE_ADJUSTMENTS', (r) => r.employee_id === employeeId && r.work_date === b.workDate && r.status === 'PENDING');
  if (dup) throw conflict('A pending regularisation already exists for this date', 'DUPLICATE_PENDING');
  const daily = await ctx.repo.findOne('ATTENDANCE_DAILY', (r) => r.employee_id === employeeId && r.work_date === b.workDate);
  const employee = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  const row = await ctx.repo.append('ATTENDANCE_ADJUSTMENTS', {
    adjustment_id: ctx.id('ADJ'), employee_id: employeeId, work_date: b.workDate, adjustment_type: b.type, adjusted_in: b.adjustedIn, adjusted_out: b.adjustedOut,
    original_first_in: daily?.first_in && Number(daily.first_in) !== 0 ? daily.first_in : undefined, original_last_out: daily?.last_out && Number(daily.last_out) !== 0 ? daily.last_out : undefined,
    reason: b.reason, requested_by: actor.user.userId, approver_employee_id: str(employee?.manager_employee_id) || undefined, ...auditCols(ctx, actor, 'PENDING'),
  });
  await ctx.audit.write(actor, { action: 'ADJUSTMENT_REQUESTED', entityType: 'ATTENDANCE_ADJUSTMENT', entityId: str(row.adjustment_id), after: row, reason: b.reason });
  return row;
}

export async function decideAdjustment(ctx: AppContext, actor: Actor, id: string, d: { decision: 'APPROVED' | 'REJECTED'; note?: string }) {
  const adj = await ctx.repo.getByKey('ATTENDANCE_ADJUSTMENTS', id);
  if (!adj) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'adjustments', 'approve', str(adj.employee_id));
  if (str(adj.employee_id) === actor.user.employeeId) throw forbidden('You cannot approve your own regularisation');
  if (adj.status !== 'PENDING') throw conflict(`Already ${str(adj.status)}`, 'ALREADY_DECIDED');
  await assertNotLocked(ctx, str(adj.work_date), 'This regularisation');
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const { before, after } = await ctx.repo.update('ATTENDANCE_ADJUSTMENTS', id, { status: d.decision, decided_at: now, decided_by: actor.user.userId, decision_note: d.note, updated_at: now, updated_by: actor.user.userId, request_id: actor.requestId });
  await ctx.audit.write(actor, { action: `ADJUSTMENT_${d.decision}`, entityType: 'ATTENDANCE_ADJUSTMENT', entityId: id, before, after, reason: d.note });
  return after;
}

export async function listAdjustments(ctx: AppContext, actor: Actor, status?: string) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'adjustments', 'read');
  return ctx.repo.find('ATTENDANCE_ADJUSTMENTS', (r) => (ids === 'ALL' || ids.has(str(r.employee_id))) && (!status || r.status === status));
}

// ------------------------------------------------------------------ scaffolding + exceptions

export async function scaffoldDaily(ctx: AppContext, actor: Actor, from: string, to: string) {
  await authorize(ctx, actor.user, 'attendance', 'write');
  const n = await scaffoldAttendanceDaily(ctx.repo, from, to, { companyId: actor.user.companyId, actor: actor.user.userId, requestId: actor.requestId, now: toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE) });
  await ctx.audit.write(actor, { action: 'ATTENDANCE_SCAFFOLD', entityType: 'ATTENDANCE_DAILY', entityId: `${from}..${to}`, after: { rows: n } });
  return { created: n };
}

/** registry maintenance: open an exception for every newly flagged day, resolve those that no longer flag */
export async function syncExceptions(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'attendance', 'write');
  const daily = await ctx.repo.readAll('ATTENDANCE_DAILY');
  const existing = await ctx.repo.readAll('ATTENDANCE_EXCEPTIONS');
  const known = new Set(existing.filter((e) => e.status !== 'RESOLVED').map((e) => str(e.attendance_key)));
  const opened: Record<string, unknown>[] = [];
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  for (const r of daily) {
    const flag = str(r.exception_flag);
    if (!flag) continue;
    const key = str(r.daily_key);
    if (known.has(key)) continue;
    opened.push({ exception_id: ctx.id('EXC'), attendance_key: key, employee_id: r.employee_id, work_date: r.work_date, exception_type: flag, detected_at: now, ...auditCols(ctx, actor, 'OPEN') });
  }
  if (opened.length) await ctx.repo.appendMany('ATTENDANCE_EXCEPTIONS', opened);
  let resolved = 0;
  for (const e of existing) {
    if (e.status === 'OPEN' && !str(e.still_flagged)) {
      await ctx.repo.update('ATTENDANCE_EXCEPTIONS', str(e.exception_id), { status: 'RESOLVED', resolved_at: now, resolved_by: 'SYSTEM', resolution_note: 'No longer flagged by attendance formulas' });
      resolved++;
    }
  }
  await ctx.audit.write(actor, { action: 'ATTENDANCE_EXCEPTIONS_SYNC', entityType: 'ATTENDANCE_EXCEPTIONS', entityId: 'sync', after: { opened: opened.length, resolved } });
  return { opened: opened.length, resolved };
}

export async function waiveException(ctx: AppContext, actor: Actor, id: string, note: string) {
  const ex = await ctx.repo.getByKey('ATTENDANCE_EXCEPTIONS', id);
  if (!ex) throw notFound();
  await requireEmployeeAccess(ctx, actor, 'attendance', 'approve', str(ex.employee_id));
  if (!note || note.length < 3) throw badRequest('A reason is required to waive an exception');
  await assertNotLocked(ctx, str(ex.work_date), 'This exception');
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const { before, after } = await ctx.repo.update('ATTENDANCE_EXCEPTIONS', id, { status: 'WAIVED', resolved_by: actor.user.userId, resolved_at: now, resolution_note: note });
  await ctx.audit.write(actor, { action: 'EXCEPTION_WAIVED', entityType: 'ATTENDANCE_EXCEPTION', entityId: id, before, after, reason: note });
  return after;
}

export { empRef, scopeAllows };
