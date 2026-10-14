import { createHash } from 'node:crypto';
import { ROLES, type Role } from '@nutex/types';
import { generateFriendlyPassword, hashPassword, passwordProblem, verifyPassword, type CreateUserBody, type UpdateUserBody } from '@nutex/validation';
import { dateToSerial } from '@nutex/sheet-connector';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, notFound, str, toLocalWallClock } from '../common/core';
import { authorize, requireEmployeeAccess, scopedEmployeeIds } from '../auth/auth';
import { verifyChain } from '../audit/audit';
import { driveFolder } from '../drive/folders';
import { syncAttendanceClock } from '../attendance/attendance';

const nowLocal = (ctx: AppContext) => toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);

// ------------------------------------------------------------------ users
// The owner / admin (SUPER_ADMIN) issues every login. An HR admin may do the same for the people of their own branch, but only for the ordinary
// roles (employee, manager, site clerk): never for another admin, HR admin or finance login, and never beyond their branch.
// Passwords are stored only as scrypt hashes; a generated password is shown once, in the response to whoever issued it.

const HR_CAN_ASSIGN = new Set<Role>(['EMPLOYEE', 'MANAGER', 'ATTENDANCE_OPERATOR']);

const isOwner = (actor: Actor) => actor.user.role === 'SUPER_ADMIN';

/** may this person manage logins at all (ROLES tab: `users`), and is the grant company-wide or per branch */
async function requireUserAdmin(ctx: AppContext, actor: Actor, action: 'read' | 'write') {
  const g = await authorize(ctx, actor.user, 'users', action);
  if (!isOwner(actor) && !g.scopes.some((s) => s === 'ALL' || s === 'BRANCH')) throw forbidden();
}

/** an HR admin may only touch people of their branches and only the ordinary roles */
function assertHrLimits(actor: Actor, target: { role?: string; locationScope?: string }) {
  if (isOwner(actor)) return;
  if (target.role !== undefined && !HR_CAN_ASSIGN.has(target.role as Role)) throw forbidden('Only the owner can give or change that role');
  if (target.locationScope !== undefined) {
    const mine = actor.user.locationScope;
    const asked = target.locationScope.split(',').map((x) => x.trim()).filter(Boolean);
    if (!asked.length || (!mine.includes('ALL') && asked.some((x) => !mine.includes(x)))) throw forbidden('Branch access must stay within your own branches');
  }
}

/**
 * A USERS row that cannot sign in: typed into the sheet by hand, or half finished (no username, role, company or password).
 * The app never treats it as a real login; "Create login" for that employee completes it in place.
 */
const isIncomplete = (u: Record<string, unknown>) => !str(u.email) || !str(u.role) || !str(u.company_id) || !str(u.password_hash);

const sameLogin = (a: unknown, b: string) => str(a).toLowerCase() === b.toLowerCase();

export async function listUsers(ctx: AppContext, actor: Actor) {
  await requireUserAdmin(ctx, actor, 'read');
  const ids = await scopedEmployeeIds(ctx, actor.user, 'users', 'read');
  const names = new Map((await ctx.repo.readAll('EMPLOYEES')).map((e) => [str(e.employee_id), str(e.full_name) || str(e.first_name)]));
  return (await ctx.repo.readAll('USERS')).filter((u) => ids === 'ALL' || ids.has(str(u.employee_id))).map((u) => ({
    userId: u.user_id, employeeId: u.employee_id, employeeName: names.get(str(u.employee_id)) ?? '', username: u.email, displayName: u.display_name, role: u.role,
    locationScope: u.location_scope, status: u.status, mustChangePassword: u.must_change_password === 'Y', lastLoginAt: u.last_login_at, incomplete: isIncomplete(u),
  }));
}

export async function createUser(ctx: AppContext, actor: Actor, b: CreateUserBody) {
  await requireUserAdmin(ctx, actor, 'write');
  if (!ROLES.includes(b.role)) throw badRequest('Unknown role');
  const emp = await ctx.repo.getByKey('EMPLOYEES', b.employeeId);
  if (!emp) throw notFound('Employee not found');
  await requireEmployeeAccess(ctx, actor, 'users', 'write', b.employeeId);
  assertHrLimits(actor, { role: b.role, locationScope: b.locationScope || undefined });
  if (emp.status !== 'ACTIVE') throw new HttpError(422, 'EMPLOYEE_NOT_IN_SERVICE', 'This employee is archived. Restore the employee before creating a login.');
  const users = await ctx.repo.readAll('USERS');
  if (users.some((u) => sameLogin(u.email, b.username))) throw conflict('That username is already taken', 'USERNAME_TAKEN');
  const half = users.find((u) => str(u.employee_id) === b.employeeId && isIncomplete(u));
  const existing = users.find((u) => u.employee_id === b.employeeId && !isIncomplete(u) && u.status !== 'DISABLED');
  if (existing) throw conflict(`This employee already has the login "${str(existing.email)}". Reset its password instead of creating another.`, 'EMPLOYEE_HAS_LOGIN');
  const generated = !b.password;
  const password = b.password ?? generateFriendlyPassword();
  const problem = passwordProblem(password, b.username);
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  const fields = {
    employee_id: b.employeeId, email: b.username, display_name: b.displayName, password_hash: await hashPassword(password), role: b.role,
    location_scope: b.locationScope || str(emp.location_id), mfa_enabled: 'N', failed_attempts: 0, locked_until: null, password_changed_at: nowLocal(ctx), must_change_password: b.forceChange ? 'Y' : 'N',
    ...auditCols(ctx, actor, 'ACTIVE'),
  };
  // a half-written row for this employee (for example typed into the sheet by hand) is completed instead of leaving a second, broken row behind
  const row = half ? (await ctx.repo.update('USERS', str(half.user_id), fields)).after : await ctx.repo.append('USERS', { user_id: ctx.id('U'), ...fields });
  await ctx.audit.write(actor, { action: 'USER_CREATED', entityType: 'USER', entityId: str(row.user_id), after: { username: b.username, role: b.role, employee_id: b.employeeId, force_change: b.forceChange } });
  return { userId: row.user_id, username: b.username, temporaryPassword: generated ? password : undefined, mustChangePassword: b.forceChange };
}

async function activeSuperAdmins(ctx: AppContext): Promise<number> {
  return (await ctx.repo.find('USERS', (u) => u.role === 'SUPER_ADMIN' && u.status === 'ACTIVE')).length;
}

/** change anything about a login: status (enable / lock / disable), role, name, branch scope, username, or the password */
export async function updateUser(ctx: AppContext, actor: Actor, userId: string, patch: UpdateUserBody) {
  await requireUserAdmin(ctx, actor, 'write');
  const u = await ctx.repo.getByKey('USERS', userId);
  if (!u) throw notFound();
  if (isIncomplete(u)) throw badRequest('This login is incomplete (it has no username, role or password). Use "Create login" for the employee to finish it.', 'LOGIN_INCOMPLETE');
  const self = userId === actor.user.userId;
  if (!isOwner(actor)) {
    // an HR admin: only ordinary accounts of their own branch, never their own account
    await requireEmployeeAccess(ctx, actor, 'users', 'write', str(u.employee_id));
    if (self) throw forbidden('Ask the owner to change your own account');
    if (!HR_CAN_ASSIGN.has(str(u.role) as Role)) throw forbidden('Only the owner can change an admin, HR or finance login');
    assertHrLimits(actor, { role: patch.role, locationScope: patch.locationScope });
  }
  if (self && patch.status && patch.status !== 'ACTIVE') throw badRequest('You cannot disable your own account');
  if (self && patch.role && patch.role !== 'SUPER_ADMIN') throw badRequest('You cannot remove your own super admin role');
  const losesAdmin = u.role === 'SUPER_ADMIN' && u.status === 'ACTIVE' && ((patch.status && patch.status !== 'ACTIVE') || (patch.role && patch.role !== 'SUPER_ADMIN'));
  if (losesAdmin && (await activeSuperAdmins(ctx)) <= 1) throw conflict('At least one active super admin must remain', 'LAST_SUPER_ADMIN');

  const upd: Record<string, unknown> = { updated_at: nowLocal(ctx), updated_by: actor.user.userId };
  if (patch.username !== undefined) {
    if ((await ctx.repo.readAll('USERS')).some((x) => x.user_id !== userId && sameLogin(x.email, patch.username!))) throw conflict('That username is already taken', 'USERNAME_TAKEN');
    upd.email = patch.username;
  }
  if (patch.status) { upd.status = patch.status; if (patch.status === 'ACTIVE') { upd.failed_attempts = 0; upd.locked_until = null; } }
  if (patch.role) { if (!ROLES.includes(patch.role)) throw badRequest('Unknown role'); upd.role = patch.role; }
  if (patch.displayName !== undefined) upd.display_name = patch.displayName;
  if (patch.locationScope !== undefined) upd.location_scope = patch.locationScope;

  let temporaryPassword: string | undefined;
  if (patch.password !== undefined || patch.resetPassword) {
    const password = patch.password ?? generateFriendlyPassword();
    const problem = passwordProblem(password, patch.username ?? str(u.email));
    if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
    if (patch.password === undefined) temporaryPassword = password;
    upd.password_hash = await hashPassword(password);
    upd.password_changed_at = nowLocal(ctx);
    upd.failed_attempts = 0;
    upd.locked_until = null;
    // a password somebody else chose is temporary by default
    upd.must_change_password = (patch.forceChange ?? !self) ? 'Y' : 'N';
  } else if (patch.forceChange !== undefined) upd.must_change_password = patch.forceChange ? 'Y' : 'N';

  const { before, after } = await ctx.repo.update('USERS', userId, upd);
  const changed = Object.keys(patch).filter((k) => k !== 'password').join(', ');
  await ctx.audit.write(actor, {
    action: 'USER_UPDATED', entityType: 'USER', entityId: userId,
    before: { username: before.email, role: before.role, status: before.status }, after: { username: after.email, role: after.role, status: after.status },
    reason: patch.password !== undefined || patch.resetPassword ? `password set by ${actor.user.role === 'SUPER_ADMIN' ? 'the owner' : 'HR'} (${changed})` : changed,
  });
  return { userId, username: after.email, status: after.status, role: after.role, mustChangePassword: after.must_change_password === 'Y', temporaryPassword };
}

/** a person changing their own password (also the forced change at first sign-in) */
export async function changePassword(ctx: AppContext, actor: Actor, current: string, next: string) {
  const u = await ctx.repo.getByKey('USERS', actor.user.userId);
  if (!u || !(await verifyPassword(current, str(u.password_hash)))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  const problem = passwordProblem(next, str(u.email));
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  if (next === current) throw badRequest('Choose a password different from the current one', 'WEAK_PASSWORD');
  await ctx.repo.update('USERS', actor.user.userId, { password_hash: await hashPassword(next), password_changed_at: nowLocal(ctx), must_change_password: 'N', updated_at: nowLocal(ctx), updated_by: actor.user.userId });
  await ctx.audit.write(actor, { action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: actor.user.userId });
}

// ------------------------------------------------------------------ settings

const SECRET_KEYS = /SECRET|KEY|TOKEN|PASSWORD/i;

export async function listSettings(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'settings', 'read');
  return (await ctx.repo.readAll('SYSTEM_CONFIG')).filter((r) => !SECRET_KEYS.test(str(r.key))).map(({ _row, ...r }) => { void _row; return r; });
}

const NUMERIC_KEYS = /^(DAY_BOUNDARY_HOURS|MAX_SEGMENT_HOURS|DUPLICATE_WINDOW_SEC|NIGHT_START_HOUR|NIGHT_END_HOUR|OT_HOURS_PER_DAY|LEAVE_YEAR_START_MONTH|CAPACITY_WARN_PCT|LOCATION_MAX_ACCURACY_M|LOCATION_MAX_AGE_SEC)$/;
const RANGES: Record<string, [number, number]> = { LOCATION_MAX_ACCURACY_M: [10, 5000], LOCATION_MAX_AGE_SEC: [30, 3600] };

export async function updateSetting(ctx: AppContext, actor: Actor, key: string, value: string | number, reason: string) {
  await authorize(ctx, actor.user, 'settings', 'write');
  if (actor.user.role !== 'SUPER_ADMIN') throw forbidden();
  const row = await ctx.repo.getByKey('SYSTEM_CONFIG', key);
  if (!row) throw notFound('Unknown setting');
  if (reason.trim().length < 3) throw badRequest('A reason is required');
  let v: string | number = value;
  if (str(row.type) === 'date') v = dateToSerial(String(value));
  else if (NUMERIC_KEYS.test(key) || str(row.type) === 'number' || str(row.type) === 'percent') {
    v = Number(value);
    if (!Number.isFinite(v)) throw badRequest(`${key} must be numeric`);
  } else if (str(row.type) === 'yn' && !['Y', 'N'].includes(String(value))) throw badRequest(`${key} must be Y or N`);
  const range = RANGES[key];
  if (range && (Number(v) < range[0] || Number(v) > range[1])) throw badRequest(`${key} must be between ${range[0]} and ${range[1]}`);
  const { before, after } = await ctx.repo.update('SYSTEM_CONFIG', key, { value: v, updated_at: nowLocal(ctx), updated_by: actor.user.userId });
  await ctx.audit.write(actor, { action: 'SYSTEM_CONFIG_CHANGED', entityType: 'SYSTEM_CONFIG', entityId: key, before: { value: before.value }, after: { value: after.value }, reason });
  return { key, value: after.value };
}

// ------------------------------------------------------------------ audit / dashboard / notifications

export async function listAudit(ctx: AppContext, actor: Actor, q: { entityType?: string; entityId?: string; actor?: string; action?: string; page?: number; pageSize?: number }) {
  await authorize(ctx, actor.user, 'audit', 'read');
  let rows = (await ctx.repo.readAll('AUDIT_LOG')).reverse();
  if (actor.user.role !== 'SUPER_ADMIN') {
    const ids = await scopedEmployeeIds(ctx, actor.user, 'audit', 'read');
    rows = rows.filter((r) => str(r.entity_type) === 'EMPLOYEE' || str(r.entity_type).startsWith('PAYROLL') ? ids === 'ALL' || ids.has(str(r.entity_id)) || str(r.entity_type).startsWith('PAYROLL') : true);
  }
  rows = rows.filter((r) => (!q.entityType || r.entity_type === q.entityType) && (!q.entityId || r.entity_id === q.entityId) && (!q.actor || r.actor_user_id === q.actor) && (!q.action || str(r.action).includes(q.action)));
  const pageSize = Math.min(q.pageSize ?? 50, 200);
  const page = Math.max(q.page ?? 1, 1);
  return { total: rows.length, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize).map(({ _row, ...r }) => { void _row; return r; }) };
}

export async function auditVerify(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'audit', 'read');
  return verifyChain(await ctx.repo.readAll('AUDIT_LOG'));
}

export async function dashboard(ctx: AppContext, actor: Actor) {
  await syncAttendanceClock(ctx);
  const rows = await ctx.repo.readAll('DASHBOARD_DATA');
  const all = Object.fromEntries(rows.map((r) => [str(r.metric_key), { label: r.label, group: r.group, value: r.value }]));
  const allowedGroups = new Set<string>(['HEADCOUNT', 'ATTENDANCE', 'APPROVALS']);
  for (const [res, groups] of [['payroll', ['PAYROLL']], ['settings', ['HEALTH', 'CAPACITY']]] as const) {
    try { await authorize(ctx, actor.user, res, 'read'); groups.forEach((g) => allowedGroups.add(g)); } catch { /* not permitted */ }
  }
  try { await authorize(ctx, actor.user, 'audit', 'read'); allowedGroups.add('HEALTH'); } catch { /* not permitted */ }
  const isCompanyWide = (await scopedEmployeeIds(ctx, actor.user, 'attendance', 'read').catch(() => new Set<string>())) === 'ALL';
  const metrics = Object.fromEntries(Object.entries(all).filter(([, m]) => allowedGroups.has(str(m.group))));
  return { companyWide: isCompanyWide, metrics };
}

export async function myNotifications(ctx: AppContext, actor: Actor) {
  await authorize(ctx, actor.user, 'notifications', 'read');
  return (await ctx.repo.find('NOTIFICATIONS', (r) => r.recipient_employee_id === actor.user.employeeId)).reverse().slice(0, 50)
    .map((r) => ({ id: r.notification_id, subject: r.subject, template: r.template, at: r.created_at, readAt: r.read_at, status: r.status }));
}

// ------------------------------------------------------------------ documents (metadata in Sheets, binary in Drive)

const ALLOWED_MIME = new Map([['application/pdf', [0x25, 0x50, 0x44, 0x46]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]]]);

export async function uploadDocument(ctx: AppContext, actor: Actor, b: { employeeId?: string; docType: string; fileName: string; mimeType: string; dataBase64: string; visibility?: 'EMPLOYEE' | 'HR_ONLY' }) {
  const employeeId = b.employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'documents', 'write', employeeId);
  const magic = ALLOWED_MIME.get(b.mimeType);
  if (!magic) throw badRequest('Only PDF, JPEG and PNG documents are accepted', 'UNSUPPORTED_TYPE');
  const data = Buffer.from(b.dataBase64, 'base64');
  if (data.length === 0 || data.length > 5_000_000) throw badRequest('Document must be between 1 byte and 5 MB');
  if (!magic.every((m, i) => data[i] === m)) throw badRequest('File content does not match its declared type', 'CONTENT_MISMATCH');
  const folder = await driveFolder(ctx, 'DOCS');
  const safeName = b.fileName.replace(/[^\w.\- ]/g, '_').slice(0, 100);
  const stored = await ctx.drive.put(folder, `${employeeId}-${safeName}`, data, b.mimeType);
  const row = await ctx.repo.append('EMPLOYEE_DOCUMENTS', {
    document_id: ctx.id('DOC'), employee_id: employeeId, doc_type: b.docType.slice(0, 40), file_name: safeName, mime_type: b.mimeType, size_bytes: data.length, drive_file_id: stored.id,
    checksum: createHash('sha256').update(data).digest('hex'), visibility: b.visibility ?? 'EMPLOYEE', uploaded_by: actor.user.userId, uploaded_at: nowLocal(ctx), ...auditCols(ctx, actor),
  });
  await ctx.audit.write(actor, { action: 'DOCUMENT_UPLOADED', entityType: 'EMPLOYEE_DOCUMENT', entityId: str(row.document_id), after: { employeeId, docType: b.docType, size: data.length } });
  return { documentId: row.document_id, fileName: safeName };
}

export async function listDocuments(ctx: AppContext, actor: Actor, employeeId?: string) {
  const emp = employeeId ?? actor.user.employeeId;
  await requireEmployeeAccess(ctx, actor, 'documents', 'read', emp);
  const own = emp === actor.user.employeeId;
  return (await ctx.repo.find('EMPLOYEE_DOCUMENTS', (r) => r.employee_id === emp && r.status === 'ACTIVE' && (own || actor.user.role !== 'EMPLOYEE') && (r.visibility !== 'HR_ONLY' || actor.user.role !== 'EMPLOYEE')))
    .map((r) => ({ documentId: r.document_id, docType: r.doc_type, fileName: r.file_name, size: r.size_bytes, uploadedAt: r.uploaded_at, visibility: r.visibility }));
}

export async function downloadDocument(ctx: AppContext, actor: Actor, documentId: string) {
  const d = await ctx.repo.getByKey('EMPLOYEE_DOCUMENTS', documentId);
  if (!d || d.status !== 'ACTIVE') throw notFound();
  await requireEmployeeAccess(ctx, actor, 'documents', 'read', str(d.employee_id));
  if (d.visibility === 'HR_ONLY' && actor.user.role === 'EMPLOYEE') throw forbidden();
  const data = await ctx.drive.get(str(d.drive_file_id));
  if (createHash('sha256').update(data).digest('hex') !== str(d.checksum)) throw new HttpError(500, 'DOCUMENT_INTEGRITY', 'Document failed its integrity check');
  await ctx.audit.write(actor, { action: 'DOCUMENT_DOWNLOADED', entityType: 'EMPLOYEE_DOCUMENT', entityId: documentId });
  return { data, name: str(d.file_name), mime: str(d.mime_type) };
}
