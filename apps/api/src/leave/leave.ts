import { dateToSerial, type Row } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, notFound, str, toLocalWallClock } from '../common/core';
import { assertNotLocked } from '../common/period';
import { authorize, requireEmployeeAccess, scopedEmployeeIds } from '../auth/auth';
import { notify } from '../notifications/notifications';

const nowLocal = (ctx: AppContext) => toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
const today = (ctx: AppContext) => nowLocal(ctx).slice(0, 10);

export async function listTypes(ctx: AppContext) {
  return (await ctx.repo.readAll('LEAVE_TYPES')).filter((t) => t.status === 'ACTIVE');
}

export async function balances(ctx: AppContext, actor: Actor, employeeId: string | undefined, year?: number) {
  const emp = employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'leave_balances', 'read', emp);
  return ctx.repo.find('LEAVE_BALANCES', (r) => r.employee_id === emp && (year === undefined || Number(r.leave_year) === year));
}

export async function listApplications(ctx: AppContext, actor: Actor, q: { status?: string; employeeId?: string; mine?: boolean }) {
  const ids = await scopedEmployeeIds(ctx, actor.user, 'leave', 'read');
  return ctx.repo.find('LEAVE_APPLICATIONS', (r) => {
    if (q.mine && r.employee_id !== actor.user.employeeId) return false;
    if (q.employeeId && r.employee_id !== q.employeeId) return false;
    if (q.status && r.status !== q.status) return false;
    return ids === 'ALL' || ids.has(str(r.employee_id));
  });
}

export async function apply(ctx: AppContext, actor: Actor, b: { leaveTypeId: string; fromDate: string; toDate: string; halfDay: 'Y' | 'N'; reason: string; employeeId?: string }, idemKey: string | undefined) {
  if (!idemKey || idemKey.length < 8) throw badRequest('Idempotency-Key header (min 8 chars) is required', 'IDEMPOTENCY_KEY_REQUIRED');
  const employeeId = b.employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'leave', 'write', employeeId);
  if (b.fromDate > b.toDate) throw badRequest('fromDate must not be after toDate');
  const type = await ctx.repo.getByKey('LEAVE_TYPES', b.leaveTypeId);
  if (!type || type.status !== 'ACTIVE') throw notFound('Unknown leave type');
  if (b.halfDay === 'Y' && (b.fromDate !== b.toDate || type.allow_half_day !== 'Y')) throw badRequest('Half day is only allowed for a single day on types that permit it');
  const emp = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  if (!emp || emp.status !== 'ACTIVE') throw new HttpError(422, 'EMPLOYEE_NOT_IN_SERVICE', 'Employee is not active');
  if (str(emp.date_of_exit) && b.fromDate > str(emp.date_of_exit)) throw new HttpError(422, 'EMPLOYEE_NOT_IN_SERVICE', 'Leave after the exit date');
  await assertNotLocked(ctx, b.fromDate, 'This leave');
  await assertNotLocked(ctx, b.toDate, 'This leave');

  const notice = Number(type.min_notice_days ?? 0);
  if (notice > 0 && (dateToSerial(b.fromDate) - dateToSerial(today(ctx))) < notice && actor.user.role === 'EMPLOYEE') throw new HttpError(422, 'MIN_NOTICE', `${str(type.name)} needs ${notice} day(s) notice`);
  const span = dateToSerial(b.toDate) - dateToSerial(b.fromDate) + 1;
  const maxConsec = Number(type.max_consecutive_days ?? 0);
  if (maxConsec > 0 && span > maxConsec) throw new HttpError(422, 'MAX_CONSECUTIVE', `At most ${maxConsec} consecutive days`);

  const key = `${actor.user.userId}:${idemKey}`;
  const prior = await ctx.repo.findOne('LEAVE_APPLICATIONS', (r) => r.idempotency_key === key);
  if (prior) return { replayed: true, application: prior };
  const overlap = await ctx.repo.findOne('LEAVE_APPLICATIONS', (r) => r.employee_id === employeeId && (r.status === 'PENDING' || r.status === 'APPROVED') && str(r.from_date) <= b.toDate && str(r.to_date) >= b.fromDate);
  if (overlap) throw conflict(`Overlaps application ${str(overlap.application_id)}`, 'OVERLAP');

  const auto = type.requires_approval === 'N';
  const app = await ctx.repo.append('LEAVE_APPLICATIONS', {
    application_id: ctx.id('LA'), employee_id: employeeId, leave_type_id: b.leaveTypeId, from_date: b.fromDate, to_date: b.toDate, half_day: b.halfDay, reason: b.reason,
    approver_employee_id: str(emp.manager_employee_id) || undefined, idempotency_key: key, ...auditCols(ctx, actor, 'PENDING'),
  });
  // balance sufficiency is a sheet formula (balance_check): react to it, never re-compute it here
  if (app.is_leave_like === 'Y' && app.balance_check === 'INSUFFICIENT') {
    await ctx.repo.update('LEAVE_APPLICATIONS', str(app.application_id), { status: 'CANCELLED', decision_note: 'Auto-cancelled: insufficient leave balance', decided_at: nowLocal(ctx), decided_by: 'SYSTEM' });
    await ctx.audit.write(actor, { action: 'LEAVE_REJECTED_INSUFFICIENT_BALANCE', entityType: 'LEAVE_APPLICATION', entityId: str(app.application_id), after: { days: app.days_count, available: app.balance_available } });
    throw new HttpError(422, 'INSUFFICIENT_BALANCE', `Insufficient balance: needs ${app.days_count} day(s), available ${app.balance_available}`);
  }
  if (Number(app.days_count) === 0) {
    await ctx.repo.update('LEAVE_APPLICATIONS', str(app.application_id), { status: 'CANCELLED', decision_note: 'Auto-cancelled: no working days in range', decided_at: nowLocal(ctx), decided_by: 'SYSTEM' });
    throw new HttpError(422, 'NO_WORKING_DAYS', 'The selected dates are all weekly offs / holidays');
  }
  await ctx.audit.write(actor, { action: 'LEAVE_APPLIED', entityType: 'LEAVE_APPLICATION', entityId: str(app.application_id), after: app });
  await notify(ctx, actor, { recipientEmployeeId: str(emp.manager_employee_id) || employeeId, template: 'LEAVE_PENDING', subject: 'Leave approval pending', payload: { application_id: app.application_id } });
  if (auto) return { replayed: false, application: await decide(ctx, { ...actor, user: { ...actor.user, role: 'SUPER_ADMIN' } }, str(app.application_id), { decision: 'APPROVED', note: 'Auto-approved (type does not need approval)' }, true) };
  return { replayed: false, application: app };
}

export async function decide(ctx: AppContext, actor: Actor, id: string, d: { decision: 'APPROVED' | 'REJECTED'; note?: string }, system = false) {
  const app = await ctx.repo.getByKey('LEAVE_APPLICATIONS', id);
  if (!app) throw notFound();
  if (!system) await requireEmployeeAccess(ctx, actor, 'leave', 'approve', str(app.employee_id));
  if (!system && str(app.employee_id) === actor.user.employeeId) throw forbidden('You cannot approve your own leave');
  if (app.status !== 'PENDING') throw conflict(`Already ${str(app.status)}`, 'ALREADY_DECIDED');
  await assertNotLocked(ctx, str(app.from_date), 'This leave');

  if (d.decision === 'APPROVED' && app.is_leave_like === 'Y') {
    if (app.balance_check === 'INSUFFICIENT') throw new HttpError(422, 'INSUFFICIENT_BALANCE', `Insufficient balance (available ${app.balance_available})`);
    await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
      txn_id: ctx.id('LTX'), employee_id: app.employee_id, leave_type_id: app.leave_type_id, leave_year: app.leave_year, txn_type: 'LEAVE_TAKEN', txn_date: str(app.from_date),
      days: -Number(app.days_count), reference_id: id, idempotency_key: `leave-taken:${id}`, remarks: 'Approved leave', ...auditCols(ctx, actor),
    });
  }
  const { before, after } = await ctx.repo.update('LEAVE_APPLICATIONS', id, {
    status: d.decision, decided_at: nowLocal(ctx), decided_by: system ? 'SYSTEM' : actor.user.userId, decision_note: d.note, updated_at: nowLocal(ctx), updated_by: actor.user.userId, request_id: actor.requestId,
  });
  await ctx.audit.write(actor, { action: `LEAVE_${d.decision}`, entityType: 'LEAVE_APPLICATION', entityId: id, before, after, reason: d.note });
  await notify(ctx, actor, { recipientEmployeeId: str(app.employee_id), template: `LEAVE_${d.decision}`, subject: `Your leave was ${d.decision.toLowerCase()}`, payload: { application_id: id, note: d.note } });
  return after;
}

export async function cancel(ctx: AppContext, actor: Actor, id: string, note?: string) {
  const app = await ctx.repo.getByKey('LEAVE_APPLICATIONS', id);
  if (!app) throw notFound();
  const own = str(app.employee_id) === actor.user.employeeId;
  if (!own) await requireEmployeeAccess(ctx, actor, 'leave', 'approve', str(app.employee_id));
  else await authorize(ctx, actor.user, 'leave', 'write');
  if (app.status !== 'PENDING' && app.status !== 'APPROVED') throw conflict(`Cannot cancel a ${str(app.status)} application`);
  await assertNotLocked(ctx, str(app.from_date), 'This leave');
  if (app.status === 'APPROVED') {
    if (str(app.from_date) < today(ctx)) throw new HttpError(422, 'PAST_LEAVE', 'Leave that has already started cannot be cancelled here; raise a regularisation');
    if (app.is_leave_like === 'Y') {
      await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
        txn_id: ctx.id('LTX'), employee_id: app.employee_id, leave_type_id: app.leave_type_id, leave_year: app.leave_year, txn_type: 'LEAVE_REVERSAL', txn_date: today(ctx),
        days: Number(app.days_count), reference_id: id, idempotency_key: `leave-reversal:${id}`, remarks: 'Cancelled after approval', ...auditCols(ctx, actor),
      });
    }
  }
  const { before, after } = await ctx.repo.update('LEAVE_APPLICATIONS', id, { status: 'CANCELLED', decided_at: nowLocal(ctx), decided_by: actor.user.userId, decision_note: note ?? 'Cancelled' });
  await ctx.audit.write(actor, { action: 'LEAVE_CANCELLED', entityType: 'LEAVE_APPLICATION', entityId: id, before, after, reason: note });
  return after;
}

// ------------------------------------------------------------------ ledger jobs (amounts come from sheet formulas)

async function setConfig(ctx: AppContext, key: string, value: string | number) {
  await ctx.repo.update('SYSTEM_CONFIG', key, { value, updated_at: nowLocal(ctx), updated_by: 'SYSTEM' });
}

/** post the sheet-calculated accrual_pending as ACCRUAL ledger rows. Idempotent per (balance, target). */
export async function runAccrual(ctx: AppContext, actor: Actor, asOfDate: string) {
  await authorize(ctx, actor.user, 'leave_balances', 'write');
  await setConfig(ctx, 'ACCRUAL_AS_OF_DATE', dateToSerial(asOfDate));
  ctx.repo.invalidate();
  const rows = (await ctx.repo.readAll('LEAVE_BALANCES')).filter((b) => Number(b.accrual_pending) > 0);
  let posted = 0;
  for (const b of rows) {
    const { created } = await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
      txn_id: ctx.id('LTX'), employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: b.leave_year, txn_type: 'ACCRUAL', txn_date: asOfDate, days: b.accrual_pending,
      reference_id: `ACCRUAL-${asOfDate}`, idempotency_key: `accrual:${str(b.balance_key)}:${b.accrual_target}`, remarks: 'Monthly accrual', ...auditCols(ctx, actor),
    });
    if (created) posted++;
  }
  await ctx.audit.write(actor, { action: 'LEAVE_ACCRUAL_RUN', entityType: 'LEAVE_TRANSACTIONS', entityId: asOfDate, after: { posted } });
  return { asOfDate, posted };
}

/** credit comp-off from the sheet-calculated comp_off_eligible of a holiday / weekly-off working day */
export async function creditCompOff(ctx: AppContext, actor: Actor, employeeId: string, workDate: string) {
  await requireEmployeeAccess(ctx, actor, 'leave_balances', 'write', employeeId);
  const d = await ctx.repo.findOne('ATTENDANCE_DAILY', (r) => r.employee_id === employeeId && r.work_date === workDate);
  const days = Number(d?.comp_off_eligible ?? 0);
  if (!d || days <= 0) throw new HttpError(422, 'NOT_ELIGIBLE', 'No comp-off earned on this date');
  const year = new Date(`${workDate}T00:00:00Z`).getUTCFullYear();
  const { row, created } = await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
    txn_id: ctx.id('LTX'), employee_id: employeeId, leave_type_id: 'LT-COMP', leave_year: year, txn_type: 'COMP_OFF_CREDIT', txn_date: workDate, days, reference_id: str(d.attendance_id),
    idempotency_key: `compoff:${employeeId}:${workDate}`, remarks: 'Comp-off for holiday / weekly-off work', ...auditCols(ctx, actor),
  });
  if (created) await ctx.audit.write(actor, { action: 'COMP_OFF_CREDITED', entityType: 'LEAVE_TRANSACTION', entityId: str(row.txn_id), after: { employeeId, workDate, days } });
  return { created, days };
}

/** year-end: carry forward the policy-capped amount, lapse the rest, roll balance rows into the next year */
export async function yearEnd(ctx: AppContext, actor: Actor, year: number) {
  await authorize(ctx, actor.user, 'leave_balances', 'write');
  const rows = (await ctx.repo.readAll('LEAVE_BALANCES')).filter((b) => Number(b.leave_year) === year);
  const nextExisting = new Set((await ctx.repo.readAll('LEAVE_BALANCES')).filter((b) => Number(b.leave_year) === year + 1).map((b) => str(b.balance_key)));
  let carried = 0, lapsed = 0;
  for (const b of rows) {
    const nextKey = `${str(b.employee_id)}:${str(b.leave_type_id)}:${year + 1}`;
    if (!nextExisting.has(nextKey)) {
      await ctx.repo.append('LEAVE_BALANCES', { balance_id: `LB-${str(b.employee_id)}-${str(b.leave_type_id)}-${year + 1}`, employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: year + 1, ...auditCols(ctx, actor) });
      nextExisting.add(nextKey);
    }
    const cf = Number(b.carry_forward_eligible);
    const lapse = Number(b.lapse_days);
    if (lapse > 0) {
      await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
        txn_id: ctx.id('LTX'), employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: year, txn_type: 'LAPSE', txn_date: `${year}-12-31`, days: -lapse, reference_id: `YE-${year}`,
        idempotency_key: `lapse:${str(b.balance_key)}`, remarks: 'Year-end lapse', ...auditCols(ctx, actor),
      });
      lapsed++;
    }
    if (cf > 0) {
      await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
        txn_id: ctx.id('LTX'), employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: year + 1, txn_type: 'CARRY_FORWARD', txn_date: `${year + 1}-01-01`, days: cf, reference_id: `YE-${year}`,
        idempotency_key: `carry:${str(b.balance_key)}`, remarks: 'Carry forward', ...auditCols(ctx, actor),
      });
      carried++;
    }
  }
  await ctx.audit.write(actor, { action: 'LEAVE_YEAR_END', entityType: 'LEAVE_BALANCES', entityId: String(year), after: { carried, lapsed } });
  return { carried, lapsed };
}

export async function encash(ctx: AppContext, actor: Actor, b: { employeeId: string; leaveTypeId: string; year: number; days: number }) {
  await requireEmployeeAccess(ctx, actor, 'leave_balances', 'write', b.employeeId);
  const bal = await ctx.repo.findOne('LEAVE_BALANCES', (r) => r.balance_key === `${b.employeeId}:${b.leaveTypeId}:${b.year}`);
  if (!bal) throw notFound('Balance not found');
  if (b.days <= 0 || b.days > Number(bal.encashable_days)) throw new HttpError(422, 'EXCEEDS_ENCASHABLE', `At most ${bal.encashable_days} day(s) can be encashed under the policy`);
  const { row } = await ctx.repo.appendIfAbsent('LEAVE_TRANSACTIONS', 'idempotency_key', {
    txn_id: ctx.id('LTX'), employee_id: b.employeeId, leave_type_id: b.leaveTypeId, leave_year: b.year, txn_type: 'ENCASHMENT', txn_date: today(ctx), days: -b.days,
    idempotency_key: `encash:${b.employeeId}:${b.leaveTypeId}:${b.year}:${Number(bal.debited)}:${b.days}`, remarks: 'Encashment', ...auditCols(ctx, actor),
  });
  await ctx.audit.write(actor, { action: 'LEAVE_ENCASHED', entityType: 'LEAVE_TRANSACTION', entityId: str(row.txn_id), after: { ...b } });
  return row;
}

export type { Row };
