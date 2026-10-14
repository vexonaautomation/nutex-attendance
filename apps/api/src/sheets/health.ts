import { str, type AppContext } from '../common/core';

export interface SheetHealth {
  backend: string;
  ok: boolean;
  formulaErrors: number;
  problems: Array<{ metric: string; label: string; value: unknown }>;
  capacity: Array<{ metric: string; label: string; usedPct: number; warn: boolean }>;
}

/** Reads the formula-driven h_* and cap_* metrics from DASHBOARD_DATA. The checks themselves are sheet formulas. */
export async function sheetHealth(ctx: AppContext): Promise<SheetHealth> {
  const rows = await ctx.repo.readAll('DASHBOARD_DATA');
  const warnAt = (await ctx.systemConfig()).num('CAPACITY_WARN_PCT', 0.8);
  const health = rows.filter((r) => str(r.metric_key).startsWith('h_'));
  const problems = health.filter((r) => typeof r.value === 'string' || Number(r.value) > 0).map((r) => ({ metric: str(r.metric_key), label: str(r.label), value: r.value }));
  const formulaErrors = health.filter((r) => str(r.metric_key).startsWith('h_errors_')).reduce((n, r) => n + (Number(r.value) || 0), 0);
  const capacity = rows.filter((r) => str(r.metric_key).startsWith('cap_')).map((r) => ({ metric: str(r.metric_key), label: str(r.label), usedPct: Math.round(Number(r.value) * 1000) / 10, warn: Number(r.value) >= warnAt }));
  return { backend: ctx.repo.gateway.kind, ok: problems.length === 0 && !capacity.some((c) => c.warn), formulaErrors, problems, capacity };
}
