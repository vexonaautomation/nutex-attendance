/**
 * Adds the protected ranges (formula blocks, system tabs, header rows) to a workbook that already has its tabs, for example one built by
 * google/apps-script/NutexSetup.gs without SERVICE_ACCOUNT_EMAIL.
 *
 *   npm run google:protect
 *
 * The service account stays an editor of every protected range (the app must keep writing). Humans listed in GOOGLE_ADMIN_EMAILS may
 * edit too; the spreadsheet owner always can. Safe to run twice: existing NUTEX protections are not duplicated.
 */
import { google } from 'googleapis';
import { buildScaledSchema } from '@nutex/formula-specs';
import { createGoogleAuth, withRetry } from '@nutex/sheet-connector';
import { env, fail, list, sleep } from '../../scripts/lib/env';
import { chunk, protectionRequests } from './structure';

const E = env();

async function main() {
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set.');
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const auth = createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON });
  const service = ((await auth.getCredentials()) as { client_email?: string }).client_email ?? '';
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = E.GOOGLE_SPREADSHEET_ID;

  // sheet ids are assigned by Google when the tabs were created: read them instead of assuming 1..N
  const got = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description))' }));
  const byTitle = new Map((got.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties?.sheetId ?? 0]));
  const missing = idx.tabs.filter((t) => !byTitle.has(t.name)).map((t) => t.name);
  if (missing.length) fail(`Tabs missing from the spreadsheet: ${missing.slice(0, 5).join(', ')}. Build the workbook first.`);

  const wanted = protectionRequests(idx, { service, admins: list(E.GOOGLE_ADMIN_EMAILS) });
  // structure.ts numbers sheets 1..N in tab order; map those ids to the real ones
  const real = (n: number) => byTitle.get(idx.tabs[n - 1].name)!;
  const remap = wanted.map((r) => {
    const p = (r as { addProtectedRange: { protectedRange: { range: { sheetId: number } } } }).addProtectedRange.protectedRange;
    return { addProtectedRange: { protectedRange: { ...p, range: { ...p.range, sheetId: real(p.range.sheetId) } } } };
  });
  // drop protections that already exist (same description)
  const have = new Set((got.data.sheets ?? []).flatMap((s) => (s.protectedRanges ?? []).map((p) => `${s.properties?.sheetId}:${p.description}`)));
  const todo = remap.filter((r) => !have.has(`${r.addProtectedRange.protectedRange.range.sheetId}:${(r.addProtectedRange.protectedRange as { description?: string }).description}`));
  console.log(`Protecting: ${todo.length} ranges to add, ${remap.length - todo.length} already present (editors: ${service}${E.GOOGLE_ADMIN_EMAILS ? `, ${E.GOOGLE_ADMIN_EMAILS}` : ''})`);
  for (const g of chunk(todo, 60)) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: g } }));
    await sleep(1200);
  }
  console.log('✔ Protections in place. Next: npm run google:verify');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
