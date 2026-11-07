import type { Resource } from '@nutex/types';
import { schemaForTab } from '@nutex/validation';
import type { SchemaIndex, TabDef } from '@nutex/formula-specs';
import { Actor, AppContext, HttpError, auditCols, badRequest, conflict, forbidden, notFound, str, toLocalWallClock } from './core';
import { authorize, requireEmployeeAccess, scopedEmployeeIds } from '../auth/auth';
import { lockedPeriodFor } from './period';

/**
 * Generic, permission-checked CRUD for master / configuration tabs. Transactional workflows (punches, leave, payroll ...)
 * have dedicated services and are deliberately NOT exposed here.
 */
export interface ResourceDef {
  path: string;
  tab: string;
  resource: Resource;
  idPrefix: string;
  /** column holding the employee this row belongs to (enables object-level scope). Omit for company-wide config. */
  employeeCol?: string;
  /** the row IS an employee (scope by its own id / branch / manager) */
  isEmployee?: boolean;
  hidden?: string[];
  /** never accepted from the client */
  readonly?: string[];
  /** rows are never edited (new row = new version) */
  versioned?: boolean;
  /** fields to blank in reads for roles without `salary` access etc. */
  sensitive?: boolean;
  /** allow only super admin to write regardless of matrix (system config) */
  adminOnlyWrite?: boolean;
  /** shared reference data any signed-in user may read (holidays, leave types ...). Writes still need ALL/BRANCH scope. */
  refRead?: boolean;
}

export const RESOURCES: ResourceDef[] = [
  { path: 'employees', tab: 'EMPLOYEES', resource: 'employees', idPrefix: 'E', isEmployee: true, hidden: ['bank_account_ref', 'bank_ifsc'] },
  { path: 'departments', tab: 'DEPARTMENTS', resource: 'employees', idPrefix: 'DEP', refRead: true },
  { path: 'designations', tab: 'DESIGNATIONS', resource: 'employees', idPrefix: 'DSG', refRead: true },
  { path: 'locations', tab: 'LOCATIONS', resource: 'settings', idPrefix: 'LOC', refRead: true },
  { path: 'shifts', tab: 'SHIFT_MASTER', resource: 'shifts', idPrefix: 'SHF', refRead: true },
  { path: 'rosters', tab: 'SHIFT_ROSTER', resource: 'rosters', idPrefix: 'RST', employeeCol: 'employee_id' },
  { path: 'holidays', tab: 'HOLIDAYS', resource: 'holidays', idPrefix: 'HOL', refRead: true },
  { path: 'leave-types', tab: 'LEAVE_TYPES', resource: 'leave', idPrefix: 'LT', refRead: true },
  { path: 'leave-policies', tab: 'LEAVE_POLICIES', resource: 'settings', idPrefix: 'POL' },
  { path: 'salary-components', tab: 'SALARY_COMPONENTS', resource: 'salary', idPrefix: 'SC' },
  { path: 'salaries', tab: 'EMPLOYEE_SALARY', resource: 'salary', idPrefix: 'SAL', employeeCol: 'employee_id', versioned: true },
  { path: 'statutory-rules', tab: 'STATUTORY_RULES', resource: 'compliance', idPrefix: 'RULE', versioned: true },
  { path: 'employment-history', tab: 'EMPLOYMENT_HISTORY', resource: 'employees', idPrefix: 'EH', employeeCol: 'employee_id', versioned: true },
];

/** company-wide (non employee-scoped) config: a SELF/TEAM grant must never satisfy it */
export async function authorizeCompanyWide(ctx: AppContext, actor: Actor, resource: Resource, action: 'read' | 'write') {
  const g = await authorize(ctx, actor.user, resource, action);
  if (!g.scopes.some((sc) => sc === 'ALL' || sc === 'BRANCH')) throw forbidden();
}

const byPath = new Map(RESOURCES.map((r) => [r.path, r]));
export function resourceDef(path: string): ResourceDef {
  const d = byPath.get(path);
  if (!d) throw notFound('Unknown resource');
  return d;
}

export const SYSTEM_COLS = new Set(['company_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'source', 'request_id']);

function tabOf(ctx: AppContext, d: ResourceDef): TabDef { return (ctx.idx as SchemaIndex).tab(d.tab); }

function strip(row: Record<string, unknown>, d: ResourceDef): Record<string, unknown> {
  const { _row, ...rest } = row;
  void _row;
  for (const h of d.hidden ?? []) delete rest[h];
  return rest;
}

/** form metadata for the generic UI: input columns only, system columns removed */
export async function resourceMeta(ctx: AppContext, actor: Actor, path: string) {
  const d = resourceDef(path);
  const tab = tabOf(ctx, d);
  let canWrite = false;
  try {
    const g = await authorize(ctx, actor.user, d.resource, 'write');
    canWrite = d.employeeCol || d.isEmployee ? true : g.scopes.some((sc) => sc === 'ALL' || sc === 'BRANCH');
  } catch { canWrite = false; }
  const { ENUMS } = await import('@nutex/formula-specs');
  const hide = new Set([...SYSTEM_COLS, 'status', ...(d.hidden ?? []).filter(() => false)]);
  return {
    path: d.path, tab: d.tab, key: tab.keyColumn, versioned: !!d.versioned, canWrite,
    columns: tab.columns.map((c) => ({
      name: c.name, kind: c.kind, type: c.type, required: !!c.required && c.name !== tab.keyColumn, enum: c.enum, values: c.enum ? ENUMS[c.enum] : undefined, ref: c.ref, note: c.note,
      editable: c.kind === 'input' && !hide.has(c.name) && !(d.readonly ?? []).includes(c.name), hidden: (d.hidden ?? []).includes(c.name),
    })),
  };
}

export async function listResource(ctx: AppContext, actor: Actor, path: string, q: { search?: string; status?: string }) {
  const d = resourceDef(path);
  let allowed: Set<string> | 'ALL' = 'ALL';
  if (d.employeeCol || d.isEmployee) allowed = await scopedEmployeeIds(ctx, actor.user, d.resource, 'read');
  else if (!d.refRead) await authorizeCompanyWide(ctx, actor, d.resource, 'read');
  const rows = await ctx.repo.readAll(d.tab);
  const s = q.search?.toLowerCase();
  return rows
    .filter((r) => (allowed === 'ALL' ? true : allowed.has(str(d.isEmployee ? r.employee_id : r[d.employeeCol!]))))
    .filter((r) => !q.status || r.status === q.status)
    .filter((r) => !s || Object.values(r).some((v) => str(v).toLowerCase().includes(s)))
    .map((r) => strip(r, d));
}

export async function getResource(ctx: AppContext, actor: Actor, path: string, id: string) {
  const d = resourceDef(path);
  const row = await ctx.repo.getByKey(d.tab, id);
  if (!row) throw notFound();
  if (d.isEmployee) await requireEmployeeAccess(ctx, actor, d.resource, 'read', id);
  else if (d.employeeCol) await requireEmployeeAccess(ctx, actor, d.resource, 'read', str(row[d.employeeCol]));
  else if (!d.refRead) await authorizeCompanyWide(ctx, actor, d.resource, 'read');
  return strip(row, d);
}

async function guardWrite(ctx: AppContext, actor: Actor, d: ResourceDef, employeeId?: string) {
  if (d.adminOnlyWrite && actor.user.role !== 'SUPER_ADMIN') throw forbidden();
  if (employeeId) await requireEmployeeAccess(ctx, actor, d.resource, 'write', employeeId);
  else await authorizeCompanyWide(ctx, actor, d.resource, 'write');
}

export async function createResource(ctx: AppContext, actor: Actor, path: string, body: unknown) {
  const d = resourceDef(path);
  const tab = tabOf(ctx, d);
  const idCol = tab.keyColumn;
  const schema = schemaForTab(tab, { omit: [...SYSTEM_COLS, 'status'], forceOptional: [idCol] });
  const parsed = schemaForTab(tab, { omit: [...SYSTEM_COLS, 'status'], forceOptional: [idCol] }).safeParse(body);
  void schema;
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'VALIDATION');
  const data = parsed.data as Record<string, unknown>;
  const target = d.isEmployee ? undefined : d.employeeCol ? str(data[d.employeeCol]) : undefined;
  if (d.isEmployee) await authorizeCompanyWide(ctx, actor, d.resource, 'write');
  else await guardWrite(ctx, actor, d, target);
  if (d.isEmployee && actor.user.locationScope.length && !actor.user.locationScope.includes('ALL') && !actor.user.locationScope.includes(str(data.location_id))) throw forbidden('Employee location is outside your branch scope');
  const id = str(data[idCol]) || ctx.id(d.idPrefix);
  if (await ctx.repo.getByKey(d.tab, id)) throw conflict(`${id} already exists`);
  if (d.tab === 'EMPLOYEE_SALARY' || d.tab === 'STATUTORY_RULES') {
    const lockedP = await lockedPeriodFor(ctx, str(data.effective_from));
    if (lockedP) throw new HttpError(423, 'PERIOD_LOCKED', `Effective date falls in LOCKED period ${str(lockedP.period_id)}. Use a later effective date and post arrears as an input.`);
  }
  const row = await ctx.repo.append(d.tab, { ...data, [idCol]: id, ...auditCols(ctx, actor) });
  await ctx.audit.write(actor, { action: `${d.tab}_CREATED`, entityType: d.tab, entityId: id, after: row });
  return strip(row, d);
}

export async function updateResource(ctx: AppContext, actor: Actor, path: string, id: string, body: unknown) {
  const d = resourceDef(path);
  if (d.versioned) throw new HttpError(405, 'VERSIONED_RESOURCE', 'This data is effective-dated: create a new version instead of editing.');
  const tab = tabOf(ctx, d);
  const parsed = schemaForTab(tab, { omit: [...SYSTEM_COLS, tab.keyColumn, ...(d.readonly ?? [])], partial: true }).partial().safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'VALIDATION');
  const before = await ctx.repo.getByKey(d.tab, id);
  if (!before) throw notFound();
  await guardWrite(ctx, actor, d, d.isEmployee ? id : d.employeeCol ? str(before[d.employeeCol]) : undefined);
  const patch = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([, v]) => v !== undefined));
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const { before: b, after } = await ctx.repo.update(d.tab, id, { ...patch, updated_at: now, updated_by: actor.user.userId, request_id: actor.requestId });
  await ctx.audit.write(actor, { action: `${d.tab}_UPDATED`, entityType: d.tab, entityId: id, before: b, after });
  return strip(after, d);
}

/**
 * "Remove" = archive: rows are never deleted (payroll, leave and audit history must stay reproducible). An archived employee can no
 * longer check in, and every login that belongs to them is disabled in the same step.
 */
export async function archiveResource(ctx: AppContext, actor: Actor, path: string, id: string, reason: string) {
  const d = resourceDef(path);
  const before = await ctx.repo.getByKey(d.tab, id);
  if (!before) throw notFound();
  await guardWrite(ctx, actor, d, d.isEmployee ? id : d.employeeCol ? str(before[d.employeeCol]) : undefined);
  if (reason.trim().length < 3) throw badRequest('A reason is required');
  if (d.isEmployee && id === actor.user.employeeId) throw forbidden('You cannot archive your own employee record');
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const { after } = await ctx.repo.update(d.tab, id, { status: 'INACTIVE', ...(d.isEmployee ? { employee_status: 'INACTIVE' } : {}), updated_at: now, updated_by: actor.user.userId, notes: reason });
  await ctx.audit.write(actor, { action: `${d.tab}_ARCHIVED`, entityType: d.tab, entityId: id, before, after, reason });
  let disabledLogins = 0;
  if (d.isEmployee) {
    for (const u of await ctx.repo.find('USERS', (r) => r.employee_id === id && r.status !== 'DISABLED')) {
      await ctx.repo.update('USERS', str(u.user_id), { status: 'DISABLED', updated_at: now, updated_by: actor.user.userId });
      await ctx.audit.write(actor, { action: 'USER_DISABLED', entityType: 'USER', entityId: str(u.user_id), reason: `Employee ${id} archived: ${reason}` });
      disabledLogins++;
    }
  }
  return { ...strip(after, d), disabledLogins };
}

/** undo an archive. Logins stay disabled: the administrator re-enables them on purpose. */
export async function restoreResource(ctx: AppContext, actor: Actor, path: string, id: string) {
  const d = resourceDef(path);
  const before = await ctx.repo.getByKey(d.tab, id);
  if (!before) throw notFound();
  await guardWrite(ctx, actor, d, d.isEmployee ? id : d.employeeCol ? str(before[d.employeeCol]) : undefined);
  if (before.status === 'ACTIVE') throw conflict('Already active', 'ALREADY_ACTIVE');
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  const { after } = await ctx.repo.update(d.tab, id, { status: 'ACTIVE', ...(d.isEmployee ? { employee_status: 'ACTIVE' } : {}), updated_at: now, updated_by: actor.user.userId });
  await ctx.audit.write(actor, { action: `${d.tab}_RESTORED`, entityType: d.tab, entityId: id, before, after });
  return strip(after, d);
}
