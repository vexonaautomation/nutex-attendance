import { SignJWT, jwtVerify } from 'jose';
import type { Action, PermissionRow, Resource, Role, Scope, SessionUser } from '@nutex/types';
import { ROLES } from '@nutex/types';
import { verifyPassword } from '@nutex/validation';
import type { Row } from '@nutex/sheet-connector';
import { AppContext, Actor, HttpError, forbidden, str, toLocalWallClock, unauthorized, wallClockToDate } from '../common/core';

export const SESSION_COOKIE = 'nutex_session';

export interface SessionClaims { sub: string; sid: string; iat: number; exp: number }

const revoked = new Map<string, number>();
function sweepRevoked(now: number) { for (const [k, exp] of revoked) if (exp < now) revoked.delete(k); }

const key = (ctx: AppContext) => new TextEncoder().encode(ctx.env.SESSION_SECRET);

export async function issueSession(ctx: AppContext, userId: string): Promise<{ token: string; expiresAt: Date; sid: string }> {
  const sid = ctx.id('SID');
  const expiresAt = new Date(ctx.now().getTime() + ctx.env.SESSION_TTL_MIN * 60_000);
  const token = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt(Math.floor(ctx.now().getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000)).sign(key(ctx));
  return { token, expiresAt, sid };
}

export function revokeSession(claims: Pick<SessionClaims, 'sid' | 'exp'>): void {
  revoked.set(claims.sid, claims.exp * 1000);
  sweepRevoked(Date.now());
}

function toSessionUser(u: Row): SessionUser {
  const scope = str(u.location_scope).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    userId: str(u.user_id), employeeId: str(u.employee_id), email: str(u.email), role: str(u.role) as Role,
    companyId: str(u.company_id), locationScope: scope.length ? scope : [], mustChangePassword: u.must_change_password === 'Y',
  };
}

/** Validates the token AND re-reads the user row: disabled users, role changes and password changes take effect immediately. */
export async function authenticate(ctx: AppContext, token: string | undefined): Promise<{ user: SessionUser; claims: SessionClaims }> {
  if (!token) throw unauthorized();
  let claims: SessionClaims;
  try {
    const { payload } = await jwtVerify(token, key(ctx), { algorithms: ['HS256'], currentDate: ctx.now() });
    claims = { sub: String(payload.sub), sid: String(payload.sid), iat: Number(payload.iat), exp: Number(payload.exp) };
  } catch {
    throw unauthorized('Session expired or invalid');
  }
  if (revoked.has(claims.sid)) throw unauthorized('Session ended');
  const row = await ctx.repo.getByKey('USERS', claims.sub);
  if (!row || row.status !== 'ACTIVE' || !ROLES.includes(str(row.role) as Role)) throw unauthorized('Account not active');
  if (!str(row.company_id)) throw unauthorized('Account is not assigned to a company');
  const changed = row.password_changed_at ? wallClockToDate(str(row.password_changed_at), ctx.env.COMPANY_TIMEZONE).getTime() / 1000 : 0;
  if (changed && claims.iat + 1 < changed) throw unauthorized('Password changed; sign in again');
  return { user: toSessionUser(row), claims };
}

export interface LoginResult { token: string; expiresAt: Date; user: SessionUser & { displayName: string } }

export async function login(ctx: AppContext, email: string, password: string, meta: { requestId: string; ip?: string }): Promise<LoginResult> {
  const users = await ctx.repo.readAll('USERS');
  const row = users.find((u) => str(u.email).toLowerCase() === email.toLowerCase());
  const now = ctx.now();
  const nowLocal = toLocalWallClock(now, ctx.env.COMPANY_TIMEZONE);
  const genericFail = new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid login ID or password');
  const sys = { user: { userId: row ? str(row.user_id) : 'ANONYMOUS', role: (row?.role as Role) ?? ('EMPLOYEE' as Role), employeeId: '', email, companyId: '', locationScope: [] }, requestId: meta.requestId, ip: meta.ip, source: 'WEB' };

  const lockoutOn = ctx.env.LOGIN_MAX_ATTEMPTS > 0;
  if (lockoutOn && row?.locked_until && wallClockToDate(str(row.locked_until), ctx.env.COMPANY_TIMEZONE).getTime() > now.getTime()) {
    await verifyPassword(password, null);
    await ctx.audit.write(sys, { action: 'LOGIN_BLOCKED_LOCKED', entityType: 'USER', entityId: sys.user.userId });
    throw new HttpError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked. Try again later.');
  }
  const ok = row && row.status === 'ACTIVE' ? await verifyPassword(password, str(row.password_hash) || null) : (await verifyPassword(password, null), false);
  if (!ok || !row) {
    if (row && lockoutOn) {
      const attempts = Number(row.failed_attempts ?? 0) + 1;
      const lock = attempts >= ctx.env.LOGIN_MAX_ATTEMPTS;
      await ctx.repo.update('USERS', str(row.user_id), {
        failed_attempts: lock ? 0 : attempts,
        locked_until: lock ? toLocalWallClock(new Date(now.getTime() + ctx.env.LOGIN_LOCK_MINUTES * 60_000), ctx.env.COMPANY_TIMEZONE) : null,
      });
    }
    await ctx.audit.write(sys, { action: 'LOGIN_FAILED', entityType: 'USER', entityId: sys.user.userId });
    throw genericFail;
  }
  const user = toSessionUser(row);
  const session = await issueSession(ctx, str(row.user_id));
  // two different tabs: write them at the same time instead of one after the other
  await Promise.all([
    ctx.repo.update('USERS', str(row.user_id), { failed_attempts: 0, locked_until: null, last_login_at: nowLocal }),
    ctx.audit.write({ ...sys, user }, { action: 'LOGIN_SUCCESS', entityType: 'USER', entityId: user.userId }),
  ]);
  return { token: session.token, expiresAt: session.expiresAt, user: { ...user, displayName: str(row.display_name) } };
}

// ------------------------------------------------------------------ authorization (deny by default)

async function permissions(ctx: AppContext): Promise<PermissionRow[]> {
  const rows = await ctx.repo.readAll('ROLES');
  return rows.map((r) => {
    const actions: Action[] = [];
    if (r.can_read === 'Y') actions.push('read');
    if (r.can_write === 'Y') actions.push('write');
    if (r.can_approve === 'Y') actions.push('approve');
    if (r.can_export === 'Y') actions.push('export');
    return { role: str(r.role) as Role, resource: str(r.resource) as Resource, actions, scope: str(r.scope) as Scope };
  });
}

export interface Grant { scopes: Scope[] }

/** throws 403 unless the role holds `action` on `resource`; returns the scopes that grant it */
export async function authorize(ctx: AppContext, user: SessionUser, resource: Resource, action: Action): Promise<Grant> {
  const perms = await permissions(ctx);
  const scopes = perms.filter((p) => p.role === user.role && p.resource === resource && p.actions.includes(action)).map((p) => p.scope);
  if (!scopes.length) throw forbidden();
  return { scopes };
}

export interface EmployeeRef { employee_id: string; location_id: string; manager_employee_id: string; company_id: string }

export function empRef(r: Row): EmployeeRef {
  return { employee_id: str(r.employee_id), location_id: str(r.location_id), manager_employee_id: str(r.manager_employee_id), company_id: str(r.company_id) };
}

/** object-level check: may `user` act on the given employee under any granted scope? */
export function scopeAllows(user: SessionUser, grant: Grant, emp: EmployeeRef): boolean {
  if (emp.company_id && user.companyId && emp.company_id !== user.companyId) return false;
  return grant.scopes.some((s) => {
    switch (s) {
      case 'ALL': return true;
      case 'BRANCH': return user.locationScope.includes('ALL') || (!!emp.location_id && user.locationScope.includes(emp.location_id));
      case 'TEAM': return emp.manager_employee_id === user.employeeId;
      case 'SELF': return emp.employee_id === user.employeeId;
    }
  });
}

export async function loadEmployee(ctx: AppContext, employeeId: string): Promise<EmployeeRef | null> {
  const r = await ctx.repo.getByKey('EMPLOYEES', employeeId);
  return r ? empRef(r) : null;
}

/** authorize + object-level scope check for a single employee. 404-style deny to avoid leaking existence. */
export async function requireEmployeeAccess(ctx: AppContext, actor: Actor, resource: Resource, action: Action, employeeId: string): Promise<EmployeeRef> {
  const grant = await authorize(ctx, actor.user, resource, action);
  const emp = await loadEmployee(ctx, employeeId);
  if (!emp || !scopeAllows(actor.user, grant, emp)) throw forbidden();
  return emp;
}

/** filter helper for list endpoints */
export async function scopedEmployeeIds(ctx: AppContext, user: SessionUser, resource: Resource, action: Action): Promise<Set<string> | 'ALL'> {
  const grant = await authorize(ctx, user, resource, action);
  if (grant.scopes.includes('ALL')) return 'ALL';
  const emps = await ctx.repo.readAll('EMPLOYEES');
  return new Set(emps.filter((e) => scopeAllows(user, grant, empRef(e))).map((e) => str(e.employee_id)));
}
