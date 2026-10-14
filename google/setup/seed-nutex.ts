/**
 * Seeds safe, synthetic demo data (no real personal information) into the workbook created by create-workbook.
 *
 *   npm run google:seed                 masters + demo users + config
 *   npm run google:seed -- --scaffold   also creates the attendance rows for the seeded period
 *
 * Demo user passwords are generated and written to .local/seed-credentials.txt (gitignored). Set SEED_PASSWORD to choose one.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildScaledSchema } from '@nutex/formula-specs';
import { GoogleSheetsGateway, SheetRepository, createGoogleAuth } from '@nutex/sheet-connector';
import { generatePassword, hashPassword } from '@nutex/validation';
import { ROOT, env, fail } from '../../scripts/lib/env';
import { applySeed } from './apply-seed';
import { SEED_USERS } from './seed-data';
import { scaffoldAttendanceDaily } from '../../apps/api/src/common/scaffold';

const E = env();

async function main() {
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set. Run npm run google:create first (SETUP_GOOGLE.md).');
  if (E.NODE_ENV === 'production' && E.ALLOW_DEMO_SEED_IN_PRODUCTION !== 'yes') fail('Refusing to seed demo data with NODE_ENV=production (set ALLOW_DEMO_SEED_IN_PRODUCTION=yes only for a throwaway workbook).');
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const gw = new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON }));
  const repo = new SheetRepository(gw, idx);

  const passwords: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const u of SEED_USERS) { passwords[u.email] = E.SEED_PASSWORD ?? generatePassword(); hashes[u.email] = await hashPassword(passwords[u.email]); }

  console.log('Seeding demo data…');
  const counts = await applySeed(repo, idx, hashes);
  console.table(counts);

  // Drive folder ids created by create-workbook
  let ids: Record<string, string> = {};
  try { ids = JSON.parse(await readFile(path.join(ROOT, '.local', 'google-ids.json'), 'utf8')); } catch { /* optional */ }
  const folder = { DRIVE_ROOT_FOLDER_ID: E.DRIVE_ROOT_FOLDER_ID ?? ids.driveRootFolderId, DRIVE_DOCS_FOLDER_ID: E.DRIVE_DOCS_FOLDER_ID ?? ids.driveDocsFolderId, DRIVE_PAYSLIP_FOLDER_ID: E.DRIVE_PAYSLIP_FOLDER_ID ?? ids.drivePayslipFolderId };
  for (const [k, v] of Object.entries(folder)) if (v) await repo.update('SYSTEM_CONFIG', k, { value: v });
  console.log('Drive folder ids written to SYSTEM_CONFIG');

  if (process.argv.includes('--scaffold')) {
    const n = await scaffoldAttendanceDaily(repo, '2026-09-01', '2026-09-30', { companyId: 'CMP-NUTEX', actor: 'seed', requestId: 'seed', now: '2026-09-01T00:00:00' });
    console.log(`Scaffolded ${n} attendance rows for September 2026`);
  }

  const file = path.join(ROOT, '.local', 'seed-credentials.txt');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `NUTEX demo credentials for ${E.GOOGLE_SPREADSHEET_ID}\n\n${SEED_USERS.map((u) => `${u.role.padEnd(20)} ${u.email.padEnd(38)} ${passwords[u.email]}`).join('\n')}\n`, 'utf8');
  console.log(`\n✔ Done. Demo logins: ${file} (gitignored)`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
