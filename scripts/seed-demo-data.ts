/**
 * Loads a month of synthetic attendance punches so dashboards, reports and payroll have something to show.
 *
 *   npm run seed:demo                    against the configured backend (Google when GOOGLE_SPREADSHEET_ID is set)
 *   npm run seed:demo -- --dry           generate + evaluate in the local emulator and print a summary (no Google)
 *
 * Requires masters to be seeded first (npm run google:seed --scaffold).
 */
import { buildScaledSchema, buildTestSchema } from '@nutex/formula-specs';
import { EmulatorGateway, GoogleSheetsGateway, SheetRepository, createGoogleAuth } from '@nutex/sheet-connector';
import { applySeed } from '../google/setup/apply-seed';
import { demoEvents } from '../google/setup/demo-attendance';
import { scaffoldAttendanceDaily } from '../apps/api/src/common/scaffold';
import { env, fail } from './lib/env';

const E = env();
const dry = process.argv.includes('--dry') || !E.GOOGLE_SPREADSHEET_ID;
const meta = { companyId: 'CMP-NUTEX', actor: 'seed', requestId: 'demo', now: '2026-09-01T00:00:00' };

async function main() {
  const events = demoEvents();
  const rows = events.map((e, i) => ({
    event_id: `EV-DEMO-${String(i + 1).padStart(5, '0')}`, employee_id: e.employee_id, event_datetime: e.event_datetime, event_datetime_utc: e.event_datetime, event_type: e.event_type,
    capture_method: e.capture_method, geo_lat: e.geo_lat, geo_lng: e.geo_lng, geo_accuracy: e.geo_accuracy, geo_status: e.geo_status, geo_distance_m: e.geo_distance_m, idempotency_key: e.idempotency_key,
    company_id: meta.companyId, created_at: e.event_datetime, created_by: 'seed', source: 'SEED', request_id: 'demo', status: 'ACTIVE',
  }));
  let repo: SheetRepository;
  if (dry) {
    const idx = buildTestSchema(80, { ATTENDANCE_EVENTS: 1200, ATTENDANCE_DAILY: 400 });
    repo = new SheetRepository(new EmulatorGateway(idx), idx, { cacheTtlMs: 0 });
    await applySeed(repo, idx, {});
    console.log('(dry run in the local emulator: nothing is written to Google)');
  } else {
    const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
    repo = new SheetRepository(new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID!, createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON })), idx);
    if ((await repo.readAll('EMPLOYEES')).length === 0) fail('No employees found. Run npm run google:seed first.');
  }
  await scaffoldAttendanceDaily(repo, '2026-09-01', '2026-09-30', meta);
  const existing = new Set((await repo.readAll('ATTENDANCE_EVENTS')).map((r) => String(r.idempotency_key)));
  const fresh = rows.filter((r) => !existing.has(r.idempotency_key));
  for (let i = 0; i < fresh.length; i += 200) await repo.appendMany('ATTENDANCE_EVENTS', fresh.slice(i, i + 200));
  console.log(`events written: ${fresh.length} (skipped ${rows.length - fresh.length} already present)`);

  const daily = await repo.readAll('ATTENDANCE_DAILY');
  const by: Record<string, number> = {};
  for (const d of daily) by[String(d.status)] = (by[String(d.status)] ?? 0) + 1;
  console.log('daily status counts (calculated by the sheet formulas):', by);
  console.log('open exceptions:', daily.filter((d) => d.exception_open === 1).length);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
