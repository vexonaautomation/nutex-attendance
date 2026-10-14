/**
 * Payslip tooling.
 *
 *   npm run tsx scripts/generate-payslip.ts -- --sample            render a sample PDF locally (layout check, no data source)
 *   npm run tsx scripts/generate-payslip.ts -- PR-2026-09          generate + upload payslips for a LOCKED period (production context)
 *
 * Payslips are always produced from the immutable PAYROLL_SNAPSHOT, never from live formulas.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderPayslip, generatePayslips } from '../apps/api/src/payroll/payroll';
import { createProductionContext } from '../apps/api/src/bootstrap';
import type { Actor } from '../apps/api/src/common/core';
import { ROOT, env, fail } from './lib/env';

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (process.argv.includes('--sample')) {
    const calc = { earned_basic: 20000, earned_hra: 8000, earned_conveyance: 1600, earned_special: 4400, bonus: 500 };
    const pdf = await renderPayslip('September 2026 (SAMPLE)', { first_name: 'Sample', last_name: 'Employee', employee_code: 'V0000' } as never, {
      paid_days: 30, lop_days: 0, gross_earnings: 34500, pf_emp: 1800, pt: 200, total_deductions: 2000, reimbursement: 0, net_pay: 32500, calc_json: JSON.stringify(calc),
    } as never);
    const out = path.join(ROOT, '.local', 'payslip-sample.pdf');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, pdf);
    console.log(`✔ sample payslip written to ${out}`);
    return;
  }
  if (!arg) fail('Usage: generate-payslip.ts --sample | <PERIOD_ID>');
  const ctx = await createProductionContext(env());
  const actor: Actor = { user: { userId: 'CLI', employeeId: '', email: 'cli@local', role: 'SUPER_ADMIN', companyId: (await ctx.systemConfig()).str('COMPANY_ID', 'CMP-NUTEX'), locationScope: ['ALL'] }, requestId: `cli-${Date.now()}`, source: 'CLI' };
  console.log(await generatePayslips(ctx, actor, arg));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
