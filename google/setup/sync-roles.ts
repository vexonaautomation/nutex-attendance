/**
 * Adds the permission rows that the current version of the app expects but your workbook's ROLES tab does not have yet
 * (for example when HR gained the right to issue logins). Existing rows are never changed or removed, so permissions you edited
 * by hand stay as you set them.
 *
 *   npm run google:roles
 */
import { buildScaledSchema } from '@nutex/formula-specs';
import { DEFAULT_PERMISSIONS } from '@nutex/types';
import { GoogleSheetsGateway, SheetRepository, createGoogleAuth } from '@nutex/sheet-connector';
import { env, fail } from '../../scripts/lib/env';

const E = env();

async function main() {
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set.');
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const repo = new SheetRepository(new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON })), idx);
  const have = await repo.readAll('ROLES');
  const known = new Set(have.map((r) => `${r.role}:${r.resource}`));
  let n = have.length;
  const missing = DEFAULT_PERMISSIONS.filter((p) => !known.has(`${p.role}:${p.resource}`));
  if (!missing.length) { console.log('✔ ROLES is already up to date.'); return; }
  await repo.appendMany('ROLES', missing.map((p) => ({
    role_id: `ROLE-${String(++n).padStart(4, '0')}`, role: p.role, resource: p.resource,
    can_read: p.actions.includes('read') ? 'Y' : 'N', can_write: p.actions.includes('write') ? 'Y' : 'N', can_approve: p.actions.includes('approve') ? 'Y' : 'N', can_export: p.actions.includes('export') ? 'Y' : 'N',
    scope: p.scope, description: `${p.role} on ${p.resource}`,
  })));
  console.log(`✔ Added ${missing.length} permission row(s): ${missing.map((p) => `${p.role} ${p.resource}`).join(', ')}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
