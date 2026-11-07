import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodTypeAny } from 'zod';
import * as V from '@nutex/validation';
import { CapacityError, ImmutableError, NotFoundError } from '@nutex/sheet-connector';
import { DEFAULT_PERMISSIONS } from '@nutex/types';
import { Actor, AppContext, HttpError, toLocalWallClock, unauthorized } from './common/core';
import { SESSION_COOKIE, authenticate, authorize, issueSession, login, revokeSession } from './auth/auth';
import * as attendance from './attendance/attendance';
import * as monthly from './attendance/monthly';
import * as bulk from './admin/bulk';
import * as leave from './leave/leave';
import * as payroll from './payroll/payroll';
import * as reqs from './payroll/requests';
import * as reports from './reports/reports';
import * as admin from './admin/admin';
import * as res from './common/resources';
import { sheetHealth } from './sheets/health';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor; requestId: string }
}

const parse = <T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};

const dateQ = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), employeeId: z.string().optional() });

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.env.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }, bodyLimit: 6 * 1024 * 1024, genReqId: () => randomUUID(), trustProxy: true });

  await app.register(cookie);
  await app.register(cors, { origin: ctx.env.CORS_ORIGIN.split(','), credentials: true, allowedHeaders: ['content-type', 'x-requested-with', 'idempotency-key', 'x-request-id'] });

  app.addHook('onRequest', async (req, reply) => {
    req.requestId = String(req.id);
    reply.header('x-request-id', req.requestId);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    // CSRF: cookie is SameSite=Strict AND state-changing calls must carry a header a cross-site form cannot set
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'nutex') throw new HttpError(403, 'CSRF', 'Missing X-Requested-With header');
  });

  app.setErrorHandler(async (err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const requestId = req.requestId ?? String(req.id);
    const send = (status: number, code: string, message: string) => reply.status(status).send({ error: { code, message, requestId } });
    if (err instanceof HttpError) return send(err.status, err.code, err.message);
    if (err instanceof ZodError) return send(400, 'VALIDATION', err.issues.map((i) => i.message).join('; '));
    if (err instanceof CapacityError) return send(507, 'CAPACITY', err.message);
    if (err instanceof ImmutableError) return send(409, 'IMMUTABLE', err.message);
    if (err instanceof NotFoundError) return send(404, 'NOT_FOUND', 'Not found');
    if (err.statusCode && err.statusCode < 500) return send(err.statusCode, 'BAD_REQUEST', err.statusCode === 413 ? 'Payload too large' : 'Bad request');
    // unexpected: log without payloads or secrets, tell the client only the request id
    try {
      await ctx.repo.append('ERROR_LOG', {
        error_id: ctx.id('ERR'), timestamp: toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE), severity: 'ERROR', module: `${req.method} ${req.routeOptions?.url ?? 'unknown'}`,
        message: String(err.message).slice(0, 300), stack_hash: String(err.stack ?? '').split('\n').slice(0, 3).join('|').slice(0, 300), request_id: requestId, user_id: req.actor?.user.userId,
      });
    } catch { /* never let logging mask the original error */ }
    req.log.error({ err: err.message, requestId }, 'unhandled error');
    return send(500, 'INTERNAL', 'Something went wrong. Quote the request id to support.');
  });

  // a person whose password was set by the administrator may do nothing but read who they are, change it, or sign out
  const PASSWORD_CHANGE_ROUTES = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']);
  const auth = async (req: FastifyRequest) => {
    const { user } = await authenticate(ctx, req.cookies[SESSION_COOKIE]);
    if (user.mustChangePassword && !PASSWORD_CHANGE_ROUTES.has(req.routeOptions?.url ?? '')) throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must choose a new password before continuing.');
    req.actor = { user, requestId: req.requestId, ip: req.ip, source: 'WEB' };
    return req.actor;
  };
  const A = (req: FastifyRequest): Actor => req.actor ?? (() => { throw unauthorized(); })();

  type H = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const secured = (fn: H): H => async (req, reply) => { await auth(req); return fn(req, reply); };
  const get = (path: string, fn: H) => app.get(path, secured(fn));
  const post = (path: string, fn: H) => app.post(path, secured(fn));
  const patch = (path: string, fn: H) => app.patch(path, secured(fn));
  const put = (path: string, fn: H) => app.put(path, secured(fn));
  const Q = <T extends ZodTypeAny>(req: FastifyRequest, s: T) => parse(s, req.query);
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const idem = (req: FastifyRequest) => req.headers['idempotency-key'] as string | undefined;

  // ---------------------------------------------------------------- public
  app.get('/api/health', async () => ({ ok: true, backend: ctx.repo.gateway.kind, time: ctx.now().toISOString() }));

  const loginBuckets = new Map<string, number[]>();
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (ctx.env.LOGIN_RATE_LIMIT_PER_MIN > 0) {
      const hits = (loginBuckets.get(ip) ?? []).filter((t) => t > Date.now() - 60_000);
      if (hits.length >= ctx.env.LOGIN_RATE_LIMIT_PER_MIN) throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait a minute.');
      loginBuckets.set(ip, [...hits, Date.now()]);
    }
    const b = parse(V.loginBody, req.body);
    const r = await login(ctx, b.email, b.password, { requestId: req.requestId, ip });
    reply.setCookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'strict', secure: ctx.env.COOKIE_SECURE, path: '/', expires: r.expiresAt });
    return { user: { userId: r.user.userId, employeeId: r.user.employeeId, email: r.user.email, role: r.user.role, displayName: r.user.displayName, locationScope: r.user.locationScope, mustChangePassword: !!r.user.mustChangePassword } };
  });

  post('/api/auth/logout', async (req, reply) => {
    const { claims } = await authenticate(ctx, req.cookies[SESSION_COOKIE]);
    revokeSession(claims);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await ctx.audit.write(A(req), { action: 'LOGOUT', entityType: 'USER', entityId: A(req).user.userId });
    return { ok: true };
  });
  post('/api/auth/change-password', async (req, reply) => {
    const b = parse(z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }).strict(), req.body);
    await admin.changePassword(ctx, A(req), b.current, b.next);
    // the password change ends every older session; give this browser a fresh one so the person stays signed in
    const s = await issueSession(ctx, A(req).user.userId);
    reply.setCookie(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: 'strict', secure: ctx.env.COOKIE_SECURE, path: '/', expires: s.expiresAt });
    return { ok: true };
  });
  get('/api/auth/me', async (req) => {
    const u = A(req).user;
    const emp = await ctx.repo.getByKey('EMPLOYEES', u.employeeId);
    const perms = (await ctx.repo.readAll('ROLES')).filter((r) => r.role === u.role).map((r) => ({ resource: r.resource, read: r.can_read === 'Y', write: r.can_write === 'Y', approve: r.can_approve === 'Y', export: r.can_export === 'Y', scope: r.scope }));
    return { user: { ...u, name: emp ? `${emp.first_name} ${emp.last_name}` : u.email }, permissions: perms };
  });
  app.get('/api/meta/default-permissions', async () => ({ count: DEFAULT_PERMISSIONS.length }));

  // ---------------------------------------------------------------- dashboard / approvals
  get('/api/dashboard', async (req) => admin.dashboard(ctx, A(req)));
  get('/api/approvals', async (req) => reqs.approvalsInbox(ctx, A(req)));
  get('/api/notifications', async (req) => admin.myNotifications(ctx, A(req)));

  // ---------------------------------------------------------------- bulk employees / salary through Excel
  app.get('/api/bulk/:kind/template', secured(async (req, reply) => {
    const q = req.query as { mode?: string };
    const t = await bulk.template(ctx, A(req), P(req).kind, q.mode !== 'blank');
    return reply.header('content-type', bulk.XLSX_MIME).header('content-disposition', `attachment; filename="${t.filename}"`).header('cache-control', 'no-store').send(t.buffer);
  }));
  post('/api/bulk/:kind/import', async (req) => bulk.importFile(ctx, A(req), P(req).kind, parse(z.object({ file: z.string().min(10).max(8_000_000), fileName: z.string().max(200).optional(), dryRun: z.boolean().default(true) }).strict(), req.body)));

  // ---------------------------------------------------------------- attendance
  get('/api/attendance/policy', async (req) => attendance.attendancePolicy(ctx, A(req)));
  post('/api/attendance/punch', async (req) => attendance.selfPunch(ctx, A(req), parse(V.punchBody, req.body ?? {}), idem(req)));
  post('/api/attendance/manual-punch', async (req) => attendance.manualPunch(ctx, A(req), parse(V.manualPunchBody, req.body)));
  get('/api/attendance/daily', async (req) => attendance.listDaily(ctx, A(req), Q(req, dateQ)).then((rows) => rows.map(({ _row, ...r }) => { void _row; return r; })));
  get('/api/attendance/me', async (req) => attendance.listDaily(ctx, A(req), { ...Q(req, dateQ), employeeId: A(req).user.employeeId }).then((rows) => rows.map(({ _row, ...r }) => { void _row; return r; })));
  get('/api/attendance/monthly/months', async (req) => monthly.listMonths(ctx, A(req)));
  get('/api/attendance/monthly', async (req) => { const q = req.query as { year?: string; month?: string }; const ym = monthly.parseYearMonth(q.year, q.month); return monthly.getMonth(ctx, A(req), ym.year, ym.month); });
  post('/api/attendance/monthly/save', async (req) => { const ym = monthly.parseYearMonth((req.body as { year?: unknown })?.year, (req.body as { month?: unknown })?.month); return monthly.saveMonth(ctx, A(req), ym.year, ym.month); });
  get('/api/attendance/events', async (req) => attendance.listEvents(ctx, A(req), Q(req, dateQ)));
  post('/api/attendance/scaffold', async (req) => { const b = parse(z.object({ from: z.string(), to: z.string() }).strict(), req.body); return attendance.scaffoldDaily(ctx, A(req), b.from, b.to); });
  post('/api/attendance/adjustments', async (req) => attendance.requestAdjustment(ctx, A(req), parse(V.adjustmentBody, req.body)));
  get('/api/attendance/adjustments', async (req) => attendance.listAdjustments(ctx, A(req), (req.query as { status?: string }).status).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/attendance/adjustments/:id/decision', async (req) => attendance.decideAdjustment(ctx, A(req), P(req).id, parse(V.decisionBody, req.body)));
  post('/api/attendance/exceptions/sync', async (req) => attendance.syncExceptions(ctx, A(req)));
  get('/api/attendance/exceptions', async (req) => { await authorize(ctx, A(req).user, 'attendance', 'read'); return ctx.repo.readAll('ATTENDANCE_EXCEPTIONS'); });
  post('/api/attendance/exceptions/:id/waive', async (req) => attendance.waiveException(ctx, A(req), P(req).id, parse(z.object({ note: z.string().min(3).max(300) }).strict(), req.body).note));

  // ---------------------------------------------------------------- leave
  get('/api/leave/types', async (req) => { A(req); return leave.listTypes(ctx).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })); });
  get('/api/leave/balances', async (req) => leave.balances(ctx, A(req), (req.query as { employeeId?: string }).employeeId, req.query && (req.query as { year?: string }).year ? Number((req.query as { year?: string }).year) : undefined).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  get('/api/leave/applications', async (req) => { const q = req.query as { status?: string; employeeId?: string; mine?: string }; return leave.listApplications(ctx, A(req), { status: q.status, employeeId: q.employeeId, mine: q.mine === 'true' }).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })); });
  post('/api/leave/applications', async (req) => leave.apply(ctx, A(req), parse(V.leaveApplyBody, req.body), idem(req)));
  post('/api/leave/applications/:id/decision', async (req) => leave.decide(ctx, A(req), P(req).id, parse(V.decisionBody, req.body)));
  post('/api/leave/applications/:id/cancel', async (req) => leave.cancel(ctx, A(req), P(req).id, (req.body as { note?: string } | undefined)?.note));
  post('/api/leave/accrual', async (req) => leave.runAccrual(ctx, A(req), parse(z.object({ asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(), req.body).asOfDate));
  post('/api/leave/year-end', async (req) => leave.yearEnd(ctx, A(req), parse(z.object({ year: z.number().int() }).strict(), req.body).year));
  post('/api/leave/encash', async (req) => leave.encash(ctx, A(req), parse(z.object({ employeeId: z.string(), leaveTypeId: z.string(), year: z.number().int(), days: z.number().positive() }).strict(), req.body)));
  post('/api/leave/comp-off', async (req) => { const b = parse(z.object({ employeeId: z.string(), workDate: z.string() }).strict(), req.body); return leave.creditCompOff(ctx, A(req), b.employeeId, b.workDate); });

  // ---------------------------------------------------------------- overtime, timesheets, expenses, loans, tax
  get('/api/overtime', async (req) => reqs.listOvertime(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/overtime', async (req) => reqs.requestOvertime(ctx, A(req), parse(V.overtimeBody, req.body)));
  post('/api/overtime/:id/decision', async (req) => reqs.decideOvertime(ctx, A(req), P(req).id, parse(V.decisionBody, req.body)));
  get('/api/timesheets', async (req) => reqs.listTimesheets(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/timesheets', async (req) => reqs.submitTimesheet(ctx, A(req), parse(V.timesheetBody, req.body)));
  post('/api/timesheets/:id/decision', async (req) => reqs.decideTimesheet(ctx, A(req), P(req).id, parse(V.decisionBody, req.body)));
  get('/api/expenses', async (req) => reqs.listExpenses(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/expenses', async (req) => reqs.submitExpense(ctx, A(req), parse(V.expenseBody, req.body)));
  post('/api/expenses/:id/decision', async (req) => reqs.decideExpense(ctx, A(req), P(req).id, parse(V.decisionBody, req.body)));
  get('/api/loans', async (req) => reqs.listLoans(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/loans', async (req) => reqs.createLoan(ctx, A(req), parse(V.loanBody, req.body)));
  get('/api/tax-declarations', async (req) => reqs.listTax(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/tax-declarations', async (req) => reqs.declareTax(ctx, A(req), parse(V.taxDeclarationBody, req.body)));
  post('/api/tax-declarations/:id/verify', async (req) => reqs.verifyTax(ctx, A(req), P(req).id, parse(z.object({ verifiedAmount: z.number().min(0) }).strict(), req.body).verifiedAmount));

  // ---------------------------------------------------------------- payroll
  get('/api/payroll/periods', async (req) => payroll.listPeriods(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return x; })));
  post('/api/payroll/periods', async (req) => {
    const b = parse(z.object({ periodId: z.string().regex(/^PR-[A-Z0-9-]{4,30}$/), label: z.string().min(2).max(60), start: z.string(), end: z.string(), runType: z.enum(['REGULAR', 'OFF_CYCLE']), cutoff: z.string().optional() }).strict(), req.body);
    return payroll.createPeriod(ctx, A(req), b);
  });
  get('/api/payroll/periods/:id', async (req) => payroll.getPeriod(ctx, A(req), P(req).id));
  post('/api/payroll/periods/:id/open', async (req) => payroll.openInputs(ctx, A(req), P(req).id));
  patch('/api/payroll/periods/:id/inputs/:employeeId', async (req) => payroll.updateInput(ctx, A(req), P(req).id, P(req).employeeId, parse(V.payrollInputPatch, req.body)));
  post('/api/payroll/periods/:id/transition', async (req) => { const b = parse(V.payrollTransitionBody, req.body); return payroll.transition(ctx, A(req), P(req).id, b.to, b.note); });
  get('/api/payroll/periods/:id/rows', async (req) => payroll.calcRows(ctx, A(req), P(req).id));
  get('/api/payroll/periods/:id/verify-snapshot', async (req) => payroll.verifySnapshot(ctx, A(req), P(req).id));
  post('/api/payroll/periods/:id/payslips', async (req) => payroll.generatePayslips(ctx, A(req), P(req).id));
  get('/api/payroll/periods/:id/export/:kind', async (req, reply) => {
    const kind = P(req).kind as 'bank' | 'pf' | 'esi' | 'register';
    if (!['bank', 'pf', 'esi', 'register'].includes(kind)) throw new HttpError(404, 'NOT_FOUND', 'Unknown export');
    const csv = await payroll.exportCsv(ctx, A(req), P(req).id, kind);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${P(req).id}-${kind}.csv"`);
    return csv;
  });
  get('/api/payslips', async (req) => payroll.myPayslips(ctx, A(req)).then((r) => r.map(({ _row, ...x }) => { void _row; return { payslipId: x.payslip_id, periodId: x.period_id, employeeId: x.employee_id, netPay: x.net_pay, generatedAt: x.generated_at }; })));
  get('/api/payslips/:id/pdf', async (req, reply) => {
    const f = await payroll.getPayslipPdf(ctx, A(req), P(req).id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${f.name}"`);
    return reply.send(f.data);
  });
  get('/api/full-final', async (req) => { await authorize(ctx, A(req).user, 'payroll', 'read'); return ctx.repo.readAll('FULL_FINAL').then((r) => r.map(({ _row, ...x }) => { void _row; return x; })); });
  post('/api/full-final', async (req) => payroll.createFullFinal(ctx, A(req), parse(z.object({ employeeId: z.string(), lastWorkingDay: z.string(), noticePeriodDays: z.number().min(0).optional(), noticeServedDays: z.number().min(0).optional(), exitPeriodId: z.string().optional(), pendingSalaryIncluded: z.enum(['Y', 'N']), otherDues: z.number().min(0).optional(), otherPayables: z.number().min(0).optional() }).strict(), req.body)));
  post('/api/full-final/:id/:to', async (req) => { const to = P(req).to.toUpperCase(); if (!['REVIEW', 'APPROVED', 'PAID'].includes(to)) throw new HttpError(404, 'NOT_FOUND', 'Unknown state'); return payroll.decideFullFinal(ctx, A(req), P(req).id, to as 'REVIEW' | 'APPROVED' | 'PAID'); });

  // ---------------------------------------------------------------- reports
  get('/api/reports', async (req) => reports.listReports(ctx, A(req)));
  get('/api/reports/:id', async (req, reply) => {
    const { page, pageSize, format, ...params } = req.query as Record<string, string>;
    const out = await reports.runNamedReport(ctx, A(req), P(req).id, params, { page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined, csv: format === 'csv' });
    if ('csv' in out) { reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${P(req).id}.csv"`); return out.csv; }
    return out;
  });

  // ---------------------------------------------------------------- admin
  get('/api/admin/sheet-health', async (req) => { await authorize(ctx, A(req).user, 'settings', 'read'); return sheetHealth(ctx); });
  get('/api/audit', async (req) => admin.listAudit(ctx, A(req), req.query as Record<string, string>));
  get('/api/audit/verify', async (req) => admin.auditVerify(ctx, A(req)));
  get('/api/settings', async (req) => admin.listSettings(ctx, A(req)));
  put('/api/settings/:key', async (req) => {
    const b = parse(z.object({ value: z.union([z.string().max(300), z.number()]), reason: z.string().min(3).max(300) }).strict(), req.body);
    return admin.updateSetting(ctx, A(req), P(req).key, b.value, b.reason);
  });
  get('/api/users', async (req) => admin.listUsers(ctx, A(req)));
  post('/api/users', async (req) => admin.createUser(ctx, A(req), parse(V.createUserBody, req.body)));
  patch('/api/users/:id', async (req) => admin.updateUser(ctx, A(req), P(req).id, parse(V.updateUserBody, req.body)));
  get('/api/documents', async (req) => admin.listDocuments(ctx, A(req), (req.query as { employeeId?: string }).employeeId));
  post('/api/documents', async (req) => admin.uploadDocument(ctx, A(req), parse(z.object({ employeeId: z.string().optional(), docType: z.string().min(2).max(40), fileName: z.string().min(1).max(120), mimeType: z.string(), dataBase64: z.string().max(8_000_000), visibility: z.enum(['EMPLOYEE', 'HR_ONLY']).optional() }).strict(), req.body)));
  get('/api/documents/:id/download', async (req, reply) => {
    const f = await admin.downloadDocument(ctx, A(req), P(req).id);
    reply.header('content-type', f.mime).header('content-disposition', `attachment; filename="${f.name}"`);
    return reply.send(f.data);
  });

  // ---------------------------------------------------------------- generic master data
  get('/api/r/:path/meta', async (req) => res.resourceMeta(ctx, A(req), P(req).path));
  get('/api/r/:path', async (req) => res.listResource(ctx, A(req), P(req).path, req.query as { search?: string; status?: string }));
  get('/api/r/:path/:id', async (req) => res.getResource(ctx, A(req), P(req).path, P(req).id));
  post('/api/r/:path', async (req) => res.createResource(ctx, A(req), P(req).path, req.body));
  patch('/api/r/:path/:id', async (req) => res.updateResource(ctx, A(req), P(req).path, P(req).id, req.body));
  post('/api/r/:path/:id/archive', async (req) => res.archiveResource(ctx, A(req), P(req).path, P(req).id, parse(z.object({ reason: z.string().min(3).max(300) }).strict(), req.body).reason));
  post('/api/r/:path/:id/restore', async (req) => res.restoreResource(ctx, A(req), P(req).path, P(req).id));

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.requestId ?? String(req.id) } }));
  return app;
}
