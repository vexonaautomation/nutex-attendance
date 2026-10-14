/**
 * Recovery for a forgotten owner / admin password. Run on the machine that holds the Google key (so only someone with access to the
 * workbook can do it):
 *
 *   npm run google:reset-password -- admin
 *
 * Sets a NEW temporary password for that username (printed once), unlocks the account and makes the person choose their own password
 * at the next sign-in. Everyone else is untouched. The reset is written to the audit log.
 */
import { buildScaledSchema } from '@nutex/formula-specs';
import { GoogleSheetsGateway, SheetRepository, createGoogleAuth } from '@nutex/sheet-connector';
import { generateFriendlyPassword, hashPassword, passwordProblem } from '@nutex/validation';
import { AuditService } from '../../apps/api/src/audit/audit';
import { createContext, loadEnv } from '../../apps/api/src/common/core';
import { env, fail } from '../../scripts/lib/env';

const E = env();

async function main() {
  const username = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!username) fail('Usage: npm run google:reset-password -- <username>');
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set.');
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const repo = new SheetRepository(new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON })), idx, { cacheTtlMs: 0, configCacheTtlMs: 0 });
  const user = (await repo.readAll('USERS')).find((u) => String(u.email ?? '').toLowerCase() === username.toLowerCase());
  if (!user) fail(`No login with the username "${username}". Names in USERS: ${(await repo.readAll('USERS')).map((u) => u.email).filter(Boolean).join(', ') || '(none)'}`);
  const password = E.NEW_PASSWORD ?? generateFriendlyPassword();
  const problem = passwordProblem(password, username);
  if (problem) fail(`NEW_PASSWORD: ${problem}`);
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: E.COMPANY_TIMEZONE ?? 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date()).reduce((o, p) => ({ ...o, [p.type]: p.value }), {} as Record<string, string>);
  const stamp = `${now.year}-${now.month}-${now.day}T${now.hour}:${now.minute}:${now.second}`;
  await repo.update('USERS', String(user.user_id), {
    password_hash: await hashPassword(password), password_changed_at: stamp, must_change_password: 'Y', failed_attempts: 0, locked_until: null, status: 'ACTIVE', updated_at: stamp, updated_by: 'RESET_SCRIPT',
  });
  const ctx = createContext({ repo, idx, drive: undefined as never, env: loadEnv({ ...process.env, NODE_ENV: 'development' }) });
  await new AuditService(ctx).write(null, { action: 'PASSWORD_RESET_BY_SCRIPT', entityType: 'USER', entityId: String(user.user_id), reason: 'google:reset-password run on the server' });
  console.log(`\n✔ New temporary password for "${username}": ${password}\n  (shown once; you will be asked to choose your own at the next sign-in)`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
