/**
 * First-run setup of a NEW, empty workbook for real use (no demo people, no demo data):
 *
 *   npm run google:init
 *
 * It writes the configuration and reference data (roles, leave types, salary components, statutory rules, one General shift),
 * your first branch, and the first SUPER_ADMIN login, the account that then creates every other employee and login in the app.
 *
 * Answers come from the prompts, or from environment variables (handy for scripted installs):
 *   COMPANY_NAME, ADMIN_NAME, ADMIN_USERNAME, ADMIN_PASSWORD (omit it to have one generated and printed once),
 *   BRANCH_NAME, BRANCH_ADDRESS, BRANCH_CITY, BRANCH_LAT, BRANCH_LNG, BRANCH_RADIUS_M, BRANCH_GEOFENCE (Y/N)
 *
 * It refuses to run twice: if USERS already has a row the workbook is considered initialised.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { buildScaledSchema } from '@nutex/formula-specs';
import { GoogleSheetsGateway, SheetRepository, createGoogleAuth, dateTimeToSerial, dateToSerial } from '@nutex/sheet-connector';
import { generateFriendlyPassword, hashPassword, passwordProblem } from '@nutex/validation';
import { ROOT, env, fail } from '../../scripts/lib/env';
import { writeReferenceTabs } from './apply-seed';
import { IDS, buildSeed } from './seed-data';

const E = env();
const tty = !!process.stdin.isTTY && !process.argv.includes('--yes');

async function main() {
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set. Run npm run google:create first and copy the ids into .env (SETUP_GOOGLE.md).');
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const gw = new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON }));
  const repo = new SheetRepository(gw, idx);

  if ((await repo.readAll('USERS')).length > 0) fail('This workbook already has users, so it is already initialised. Manage people and logins in the app (Settings -> Logins).');

  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (envKey: string, question: string, fallback: string): Promise<string> => {
    const preset = E[envKey];
    if (preset !== undefined && preset !== '') return preset.trim();
    if (!rl) return fallback;
    const a = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return a || fallback;
  };

  console.log('NUTEX first-run setup. Press Enter to accept a [default].\n');
  const company = await ask('COMPANY_NAME', 'Company name', 'My Company');
  const adminName = await ask('ADMIN_NAME', 'Your full name (the first administrator)', 'Administrator');
  const username = await ask('ADMIN_USERNAME', 'Username you will sign in with', 'admin');
  const branchName = await ask('BRANCH_NAME', 'Your first branch / office name', 'Head Office');
  const city = await ask('BRANCH_CITY', 'City', '');
  const address = await ask('BRANCH_ADDRESS', 'Address', '');
  const lat = await ask('BRANCH_LAT', 'Branch latitude (e.g. 19.076090, leave blank to set it later from the app)', '');
  const lng = await ask('BRANCH_LNG', 'Branch longitude (e.g. 72.877426)', '');
  const radius = Number(await ask('BRANCH_RADIUS_M', 'Allowed distance from the branch in metres', '200'));
  const geofence = (await ask('BRANCH_GEOFENCE', 'Only allow check-in inside that distance? (Y/N)', 'N')).toUpperCase() === 'Y' ? 'Y' : 'N';
  rl?.close();

  if (!/^[A-Za-z0-9._@+-]{3,80}$/.test(username)) fail('Username must be 3-80 characters: letters, digits and . _ @ + -');
  const hasCoords = lat !== '' && lng !== '';
  if (hasCoords && !(Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)))) fail('Latitude must be between -90 and 90 and longitude between -180 and 180.');
  if (geofence === 'Y' && !hasCoords) fail('A geofence needs the branch latitude and longitude. Enter them, or answer N to the geofence question and set them later in Settings -> Organisation -> Branches.');
  if (!(radius >= 20 && radius <= 5000)) fail('Distance must be between 20 and 5000 metres.');

  const generated = !E.ADMIN_PASSWORD;
  const password = E.ADMIN_PASSWORD ?? generateFriendlyPassword();
  const problem = passwordProblem(password, username);
  if (problem) fail(`ADMIN_PASSWORD: ${problem}`);

  const tz = E.COMPANY_TIMEZONE ?? 'Asia/Kolkata';
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date()).reduce((o, p) => ({ ...o, [p.type]: p.value }), {} as Record<string, string>);
  const today = `${stamp.year}-${stamp.month}-${stamp.day}`;
  const nowLocal = `${today}T${stamp.hour}:${stamp.minute}:${stamp.second}`;
  const AUD = { company_id: IDS.company, created_at: nowLocal, created_by: 'init', updated_at: nowLocal, updated_by: 'init', source: 'SETUP', request_id: 'init', status: 'ACTIVE', notes: '' };

  console.log('\nWriting configuration and reference data…');
  const seed = buildSeed({});
  const override: Record<string, string | number> = {
    COMPANY_NAME: company, TIMEZONE_DEFAULT: tz, ACCRUAL_AS_OF_DATE: dateToSerial(today), ATTENDANCE_AS_OF: dateTimeToSerial(nowLocal), DASHBOARD_DATE: dateToSerial(today),
    ACTIVE_PERIOD_ID: `PR-${today.slice(0, 7)}`,
  };
  const config: Array<Record<string, unknown>> = seed.SYSTEM_CONFIG.map((r) => (String(r.key) in override ? { ...r, value: override[String(r.key)], updated_at: nowLocal } : { ...r, updated_at: nowLocal }));

  let ids: Record<string, string> = {};
  try { ids = JSON.parse(await readFile(path.join(ROOT, '.local', 'google-ids.json'), 'utf8')); } catch { /* optional */ }
  const folders: Record<string, string | undefined> = {
    DRIVE_ROOT_FOLDER_ID: E.DRIVE_ROOT_FOLDER_ID ?? ids.driveRootFolderId, DRIVE_DOCS_FOLDER_ID: E.DRIVE_DOCS_FOLDER_ID ?? ids.driveDocsFolderId, DRIVE_PAYSLIP_FOLDER_ID: E.DRIVE_PAYSLIP_FOLDER_ID ?? ids.drivePayslipFolderId,
  };
  const withFolders = config.map((r) => (folders[String(r.key)] ? { ...r, value: folders[String(r.key)] } : r));

  const reference: Array<[string, Record<string, unknown>[]]> = [
    ['SYSTEM_CONFIG', withFolders], ['ROLES', seed.ROLES], ['SALARY_COMPONENTS', seed.SALARY_COMPONENTS], ['STATUTORY_RULES', seed.STATUTORY_RULES],
    ['LEAVE_TYPES', seed.LEAVE_TYPES], ['LEAVE_POLICIES', seed.LEAVE_POLICIES], ['SHIFT_MASTER', seed.SHIFT_MASTER.filter((s) => s.shift_id === IDS.shiftGen)],
  ];
  for (const [tab, rows] of reference) { await repo.appendMany(tab, rows); console.log(`  ${tab.padEnd(18)} ${rows.length} rows`); }

  const branchId = 'LOC-MAIN';
  await repo.append('LOCATIONS', {
    location_id: branchId, name: branchName, address, city, state: '', timezone: tz, latitude: hasCoords ? Number(lat) : undefined, longitude: hasCoords ? Number(lng) : undefined,
    geofence_radius_m: radius, geofence_required: geofence, ...AUD,
  });
  const [first, ...rest] = adminName.split(/\s+/);
  const employeeId = 'E001';
  await repo.append('EMPLOYEES', {
    employee_id: employeeId, employee_code: 'EMP001', first_name: first, last_name: rest.join(' '), email: username.includes('@') ? username : '', phone: '', date_of_joining: today,
    employment_type: 'PERMANENT', employee_status: 'ACTIVE', location_id: branchId, default_shift_id: IDS.shiftGen, weekly_off_pattern: 'SUN', ot_eligible: 'N', pf_applicable: 'N', esi_applicable: 'N', pt_applicable: 'N', ...AUD,
  });
  await repo.append('USERS', {
    user_id: 'U001', employee_id: employeeId, email: username, display_name: adminName, password_hash: await hashPassword(password), role: 'SUPER_ADMIN', location_scope: 'ALL',
    mfa_enabled: 'N', failed_attempts: 0, password_changed_at: nowLocal, must_change_password: 'Y', ...AUD,
  });
  await writeReferenceTabs(repo, idx);
  repo.invalidate();
  await mkdir(path.join(ROOT, '.local'), { recursive: true });

  console.log('\n==============================================================');
  console.log(' Workbook is ready. Your administrator login:');
  console.log(`   Username: ${username}`);
  if (generated) console.log(`   Password: ${password}      <- shown ONCE, write it down`);
  else console.log('   Password: the ADMIN_PASSWORD you provided');
  console.log(' You will be asked to choose a new password at first sign-in.');
  console.log('==============================================================');
  console.log('\nNext: npm run google:verify   then   npm run dev:api  and  npm run dev:web');
  console.log('In the app: Employees -> Add employee, then Settings -> Logins to give each person a username and password.');
  if (!hasCoords) console.log('Remember: set the branch coordinates (Settings -> Organisation -> Branches -> Edit -> "Use my current location").');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
