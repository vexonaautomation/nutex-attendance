import type { Row } from '@nutex/sheet-connector';
import { AppContext, HttpError, str } from './core';

/** the LOCKED regular payroll period covering an ISO date, if any (validation only; the lock state itself lives in PAYROLL_CONTROL) */
export async function lockedPeriodFor(ctx: AppContext, isoDate: string): Promise<Row | undefined> {
  const cfg = await ctx.systemConfig();
  if (!cfg.yn('PERIOD_LOCK_ENFORCE')) return undefined;
  const periods = await ctx.repo.readAll('PAYROLL_CONTROL');
  return periods.find((p) => p.status === 'LOCKED' && p.run_type === 'REGULAR' && str(p.period_start) <= isoDate && str(p.period_end) >= isoDate);
}

export async function assertNotLocked(ctx: AppContext, isoDate: string, what: string): Promise<void> {
  const p = await lockedPeriodFor(ctx, isoDate);
  if (p) throw new HttpError(423, 'PERIOD_LOCKED', `${what} falls in payroll period ${str(p.period_id)}, which is LOCKED. Raise an arrears / off-cycle correction instead.`);
}

export function isoDatePart(dt: string): string { return dt.slice(0, 10); }
