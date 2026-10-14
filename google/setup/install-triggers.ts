/**
 * Apps Script is OPTIONAL in this architecture. The Node API already batches, retries, locks (in-process) and audits.
 * Apps Script adds two things a Node process cannot do natively:
 *   1. LockService-protected web-app gateway (`doPost`) for multi-instance deployments
 *   2. time-driven maintenance triggers (nightly exception sync, monthly accrual, notification drain, weekly backup)
 *
 * Installing triggers needs the *human owner's* consent in the Apps Script UI (service accounts cannot authorise them),
 * so this script validates the bundle and prints the exact steps instead of pretending to do it.
 *
 *   npm run google:triggers
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, env, fail } from '../../scripts/lib/env';

const dir = path.join(ROOT, 'google', 'apps-script');
const required = ['Code.gs', 'Config.gs', 'SheetRepository.gs', 'AttendanceService.gs', 'PayrollService.gs', 'LeaveService.gs', 'AuditService.gs', 'LockService.gs', 'NotificationService.gs', 'Setup.gs', 'appsscript.json'];

const missing = required.filter((f) => !existsSync(path.join(dir, f)));
if (missing.length) fail(`Apps Script bundle incomplete: ${missing.join(', ')}`);

const manifest = JSON.parse(readFileSync(path.join(dir, 'appsscript.json'), 'utf8')) as { runtimeVersion: string; oauthScopes: string[]; timeZone: string };
if (manifest.runtimeVersion !== 'V8') fail('appsscript.json must use runtimeVersion V8');
const broad = manifest.oauthScopes.filter((s) => /\/auth\/(drive|gmail|calendar)$/.test(s));
if (broad.length) fail(`Overly broad OAuth scopes in appsscript.json: ${broad.join(', ')}`);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.gs'))) {
  const src = readFileSync(path.join(dir, f), 'utf8');
  if (/AKIA|BEGIN PRIVATE KEY|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{16,}/i.test(src)) fail(`${f} looks like it contains a secret. Use Script Properties.`);
}

const E = env();
if (E.GOOGLE_SPREADSHEET_ID) {
  writeFileSync(path.join(dir, '.clasp.json.example'), JSON.stringify({ scriptId: '<SCRIPT_ID_FROM_APPS_SCRIPT_SETTINGS>', rootDir: '.', parentId: [E.GOOGLE_SPREADSHEET_ID] }, null, 2));
}

console.log(`✔ Apps Script bundle valid (${required.length} files, V8, ${manifest.oauthScopes.length} scopes, time zone ${manifest.timeZone}).

Manual steps (about 5 minutes, done once by the workbook owner):

  1. Open the workbook  ->  Extensions  ->  Apps Script.
  2. Create one file per google/apps-script/*.gs and paste its content (NOT NutexSetup.gs: that is the one-off workbook builder, see SETUP_GOOGLE.md step 6)
     (or: npm i -g @google/clasp; clasp login; cd google/apps-script; cp .clasp.json.example .clasp.json; edit scriptId; clasp push).
  3. Project Settings -> "Show appsscript.json manifest file" and paste google/apps-script/appsscript.json.
  4. Project Settings -> Script properties: add
        GATEWAY_TOKEN      a long random string (only if you deploy the web-app gateway)
        (no other properties are required)
  5. Run the function  installTriggers  once and accept the permission prompt.
  6. Optional gateway: Deploy -> New deployment -> Web app -> Execute as: Me, Access: Anyone with the link
     (requests are rejected without GATEWAY_TOKEN). Put the URL in .env as APPS_SCRIPT_GATEWAY_URL.
  7. Run  verifyHealth  from the "NUTEX" menu that appears in the sheet.
`);
