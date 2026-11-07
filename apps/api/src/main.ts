import path from 'node:path';
import { buildApp } from './app';
import { createEmulatorContext, createProductionContext } from './bootstrap';
import { scaffoldAttendanceDaily } from './common/scaffold';
import { loadProjectEnv } from './common/dotenv';
import { demoEvents } from '../../../google/setup/demo-attendance';

async function main() {
  const envFile = loadProjectEnv();
  if (envFile) console.log(`[nutex] settings loaded from ${envFile}`);
  const backend = process.env.NUTEX_BACKEND ?? 'google';
  const port = Number(process.env.PORT ?? 4000);
  let ctx;
  if (backend === 'emulator') {
    if (process.env.NODE_ENV === 'production') throw new Error('NUTEX_BACKEND=emulator is refused in production');
    const credentialsFile = path.resolve(process.cwd(), '../../.local/seed-credentials.txt');
    const e = await createEmulatorContext({ full: false, rows: 400, big: { ATTENDANCE_EVENTS: 1500, ATTENDANCE_DAILY: 900, PAYROLL_INPUTS: 40, PAYROLL_CALC: 40, STATUTORY_CALC: 40 }, credentialsFile, password: process.env.SEED_PASSWORD,
      // local testing: login `admin` / `123`, and no lockout / rate limit (both are refused in production)
      devAdmin: process.env.NUTEX_DEV_ADMIN !== '0',
      env: process.env.NUTEX_DEV_ADMIN === '0' ? {} : { LOGIN_MAX_ATTEMPTS: 0, LOGIN_RATE_LIMIT_PER_MIN: 0 } });
    ctx = e.ctx;
    // local testing: the demo branch has no real coordinates and phones/laptops on a desk are rarely precise, so accept a wide accuracy
    await ctx.repo.update('SYSTEM_CONFIG', 'LOCATION_MAX_ACCURACY_M', { value: 5000 });
    await scaffoldAttendanceDaily(ctx.repo, '2026-09-01', '2026-09-30', { companyId: 'CMP-NUTEX', actor: 'seed', requestId: 'seed', now: '2026-09-01T00:00:00' });
    // a synthetic month of punches so dashboards, reports and payroll have something to show
    await ctx.repo.appendMany('ATTENDANCE_EVENTS', demoEvents().map((e, i) => ({
      event_id: `EV-DEMO-${String(i + 1).padStart(5, '0')}`, employee_id: e.employee_id, event_datetime: e.event_datetime, event_datetime_utc: e.event_datetime, event_type: e.event_type,
      capture_method: e.capture_method, geo_lat: e.geo_lat, geo_lng: e.geo_lng, geo_accuracy: e.geo_accuracy, geo_status: e.geo_status, geo_distance_m: e.geo_distance_m, idempotency_key: e.idempotency_key,
      company_id: 'CMP-NUTEX', created_at: e.event_datetime, created_by: 'seed', source: 'SEED', request_id: 'demo', status: 'ACTIVE',
    })));
    console.log(`[nutex] EMULATOR backend (offline dev). Demo logins are in ${credentialsFile}`);
    if (process.env.NUTEX_DEV_ADMIN !== '0') console.log('[nutex] LOCAL TEST MODE: login admin / 123, sign-in lockout and rate limit are OFF (set NUTEX_DEV_ADMIN=0 to turn this off)');
  } else {
    ctx = await createProductionContext();
  }
  const app = await buildApp(ctx);
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
  // Render's free plan sleeps a service after 15 idle minutes: ping our own public URL every 2 minutes (set KEEP_ALIVE=0 to turn off)
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl && process.env.KEEP_ALIVE !== '0') {
    setInterval(() => { fetch(`${publicUrl}/api/health`).catch(() => undefined); }, 120_000).unref();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
