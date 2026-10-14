import { REPORTS, missingParams, runReport, toCsv, type ReportDef, type ReportRow } from '@nutex/report-engine';
import type { Row } from '@nutex/sheet-connector';
import { Actor, AppContext, badRequest, notFound, str } from '../common/core';
import { authorize, scopedEmployeeIds } from '../auth/auth';

export async function listReports(ctx: AppContext, actor: Actor) {
  const out = [];
  for (const d of REPORTS) {
    try {
      await authorize(ctx, actor.user, d.resource, 'read');
      out.push({ id: d.id, title: d.title, description: d.description, params: d.params, columns: d.columns });
    } catch { /* role has no access to this report */ }
  }
  return out;
}

function parse(v: unknown): Record<string, unknown> {
  try { return JSON.parse(str(v) || '{}') as Record<string, unknown>; } catch { return {}; }
}

async function loadRows(ctx: AppContext, def: ReportDef, params: Record<string, string>): Promise<Row[] | ReportRow[]> {
  const periodId = params.period;
  const locked = periodId ? (await ctx.repo.getByKey('PAYROLL_CONTROL', periodId))?.status === 'LOCKED' : false;
  const lockedSnap = async () => {
    const p = await ctx.repo.getByKey('PAYROLL_CONTROL', periodId);
    return ctx.repo.find('PAYROLL_SNAPSHOT', (r) => r.period_id === periodId && Number(r.period_version) === Number(p?.version));
  };
  switch (def.source) {
    case 'PAYROLL':
      if (locked) return (await lockedSnap()).map((r) => ({ ...(parse(r.calc_json) as ReportRow), ...(r as unknown as ReportRow) }));
      return ctx.repo.find('PAYROLL_CALC', (r) => r.period_id === periodId);
    case 'STATUTORY_CALC':
      if (locked) return (await lockedSnap()).map((r) => ({ ...(parse(r.calc_json) as ReportRow), employee_id: r.employee_id as string }));
      return (await ctx.repo.find('STATUTORY_CALC', () => true)).filter((r) => str(r.input_id).startsWith(`PI-${periodId}-`));
    case 'PAYROLL_INPUTS':
      if (locked) return (await lockedSnap()).map((r) => ({ ...(parse(r.inputs_json) as ReportRow), employee_id: r.employee_id as string, period_id: r.period_id as string }));
      return ctx.repo.find('PAYROLL_INPUTS', (r) => r.period_id === periodId);
    case 'OVERTIME': return ctx.repo.readAll('OVERTIME');
    default: return ctx.repo.readAll(def.source);
  }
}

export async function runNamedReport(ctx: AppContext, actor: Actor, id: string, params: Record<string, string>, o: { page?: number; pageSize?: number; csv?: boolean }) {
  const def = REPORTS.find((r) => r.id === id);
  if (!def) throw notFound('Unknown report');
  await authorize(ctx, actor.user, def.resource, o.csv ? 'export' : 'read');
  const miss = missingParams(def, params);
  if (miss.length) throw badRequest(`Missing parameter(s): ${miss.join(', ')}`);
  const ids = await scopedEmployeeIds(ctx, actor.user, def.resource, o.csv ? 'export' : 'read');
  const employees = new Map((await ctx.repo.readAll('EMPLOYEES')).map((e) => [str(e.employee_id), e]));
  const raw = await loadRows(ctx, def, params);
  const rows: ReportRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const eid = str(r.employee_id);
    if (ids !== 'ALL' && !ids.has(eid)) continue;
    const e = employees.get(eid);
    const { _row, ...rest } = r as Record<string, unknown> & { _row?: number };
    void _row;
    rows.push({ ...(rest as ReportRow), employee_code: str(e?.employee_code), employee_name: `${str(e?.first_name)} ${str(e?.last_name)}`.trim(), department_id: str(e?.department_id), location_id: str(e?.location_id) });
  }
  const result = runReport(def, rows, params, { page: o.page, pageSize: o.csv ? 100000 : o.pageSize });
  await ctx.audit.write(actor, { action: o.csv ? 'REPORT_EXPORTED' : 'REPORT_VIEWED', entityType: 'REPORT', entityId: id, after: { params, rows: result.total } });
  return o.csv ? { csv: toCsv(result.columns, result.rows) } : result;
}
