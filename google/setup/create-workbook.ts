/**
 * Builds the "NUTEX Attendance & Payroll DB" workbook (44 tabs, formulas, dropdowns, protections) and, where possible, Drive folders.
 *
 *   npm run google:create             fills YOUR blank spreadsheet when GOOGLE_SPREADSHEET_ID is set (share it with the service
 *                                     account as Editor first: recommended), otherwise creates a new one owned by the service account
 *   npm run google:create -- --dry    prints the plan (tabs, cell budget, request counts) without touching Google
 *
 * Needs (see SETUP_GOOGLE.md): GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON, optional GOOGLE_ADMIN_EMAILS,
 * CAPACITY_SCALE.
 */
import { google } from 'googleapis';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKBOOK_NAME, buildScaledSchema, totalCells } from '@nutex/formula-specs';
import { createGoogleAuth, withRetry } from '@nutex/sheet-connector';
import { ROOT, env, fail, list, sleep } from '../../scripts/lib/env';
import { addSheetRequests, chunk, describeTab, formatRequests, namedRangeRequests, protectionRequests, validationRequests, valueUpdates } from './structure';

const E = env();
const dry = process.argv.includes('--dry');
const scale = Number(E.CAPACITY_SCALE ?? 1);
const idx = buildScaledSchema(scale);

async function main() {
  const cells = totalCells(idx);
  console.log(`NUTEX workbook plan: ${idx.tabs.length} tabs, ${cells.toLocaleString()} cells (limit 10,000,000), CAPACITY_SCALE=${scale}`);
  if (cells > 8_000_000) console.warn('⚠ more than 8M cells: lower CAPACITY_SCALE or plan to archive closed periods early (docs/operations-runbook.md)');
  const values = valueUpdates(idx);
  const formatReqs = [...formatRequests(idx), ...validationRequests(idx), ...namedRangeRequests(idx)];
  console.log(`  ${values.length} value ranges, ${formatReqs.length} format/validation/named-range requests, ${idx.tabs.length} tab protections`);
  if (dry) {
    for (const t of idx.tabs) console.log('  -', JSON.stringify(describeTab(t, idx)));
    return;
  }
  if (!E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !E.GOOGLE_SERVICE_ACCOUNT_JSON) fail('No Google credentials. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path) or GOOGLE_SERVICE_ACCOUNT_JSON in .env. See SETUP_GOOGLE.md');

  const auth = createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON });
  const creds = (await auth.getCredentials()) as { client_email?: string };
  const service = creds.client_email ?? '';
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const tz = E.COMPANY_TIMEZONE ?? 'Asia/Kolkata';
  let spreadsheetId: string;
  let spreadsheetUrl: string | null | undefined;
  let blankSheets: number[] = [];
  if (E.GOOGLE_SPREADSHEET_ID) {
    // RECOMMENDED for a personal Gmail: you created a blank spreadsheet in your own Drive and shared it with the service account as Editor.
    // (A service account has no Drive storage quota of its own, so it is best not to make it the owner of the data.)
    spreadsheetId = E.GOOGLE_SPREADSHEET_ID;
    console.log('Using your existing spreadsheet (GOOGLE_SPREADSHEET_ID)…');
    const got = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetUrl,sheets.properties(sheetId,title)' })).catch((e: Error) => fail(`Cannot open the spreadsheet. Did you share it with ${service} as Editor? (${e.message})`));
    spreadsheetUrl = got.data.spreadsheetUrl;
    const have = (got.data.sheets ?? []).map((s) => ({ id: s.properties?.sheetId ?? 0, title: s.properties?.title ?? '' }));
    const clash = have.filter((s) => idx.tabs.some((t) => t.name === s.title));
    if (clash.length) fail(`This spreadsheet already has NUTEX tabs (${clash.map((c) => c.title).slice(0, 3).join(', ')}…). Use a new blank spreadsheet.`);
    blankSheets = have.map((s) => s.id);
    console.log(`  ${spreadsheetUrl}`);
  } else {
    console.log('Creating spreadsheet…');
    const created = await withRetry(() => sheets.spreadsheets.create({ requestBody: { properties: { title: WORKBOOK_NAME, locale: 'en_GB', timeZone: tz } }, fields: 'spreadsheetId,spreadsheetUrl,sheets.properties.sheetId' }));
    spreadsheetId = created.data.spreadsheetId!;
    spreadsheetUrl = created.data.spreadsheetUrl;
    blankSheets = [created.data.sheets?.[0]?.properties?.sheetId ?? 0];
    console.log(`  ${spreadsheetUrl}`);
  }

  // formulas depend on the locale (decimal point, argument separator), so pin it
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { updateSpreadsheetProperties: { properties: { locale: 'en_GB', timeZone: tz, title: WORKBOOK_NAME }, fields: 'locale,timeZone,title' } },
    ...addSheetRequests(idx), ...blankSheets.map((sheetId) => ({ deleteSheet: { sheetId } })),
  ] } }));
  console.log(`Created ${idx.tabs.length} tabs`);

  console.log('Writing headers and formulas…');
  let n = 0;
  for (const group of chunk(values, 12)) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: group.map((g) => ({ range: g.range, values: g.values as unknown[][] })) } }));
    n += group.length;
    process.stdout.write(`\r  ${n}/${values.length} ranges`);
    await sleep(1200); // stay well under the 60 writes / minute / user quota
  }
  console.log('');

  console.log('Formatting, validations and named ranges…');
  for (const g of chunk(formatReqs, 350)) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: g } }));
    await sleep(1200);
  }

  console.log('Protecting system and formula ranges…');
  const admins = list(E.GOOGLE_ADMIN_EMAILS);
  for (const g of chunk(protectionRequests(idx, { service, admins }), 60)) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: g } }));
    await sleep(1200);
  }

  // Drive holds only payslip PDFs and employee documents. Attendance, location, leave and payroll figures live entirely in Sheets.
  // A service account cannot own uploaded files (no storage quota): folders must sit inside a Shared Drive (DRIVE_PARENT_FOLDER_ID).
  const usingExisting = !!E.GOOGLE_SPREADSHEET_ID;
  let root = '';
  let docs = '';
  let payslips = '';
  if (usingExisting && !E.DRIVE_PARENT_FOLDER_ID) {
    console.log('Skipping Drive folders (your own spreadsheet, no DRIVE_PARENT_FOLDER_ID). Attendance, leave and payroll work fully; employee-document upload and stored payslip PDFs need a Shared Drive folder (SETUP_GOOGLE.md, step 9).');
  } else {
    console.log('Creating Drive folders…');
    try {
      const mk = async (name: string, parent?: string) => (await withRetry(() => drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined }, fields: 'id', supportsAllDrives: true }))).data.id!;
      root = await mk('NUTEX', E.DRIVE_PARENT_FOLDER_ID || undefined);
      docs = await mk('employee-documents', root);
      payslips = await mk('payslips', root);
      if (!usingExisting) await withRetry(() => drive.files.update({ fileId: spreadsheetId, addParents: root, fields: 'id', supportsAllDrives: true }));
    } catch (e) {
      console.warn(`  Drive folders could not be created (${e instanceof Error ? e.message : e}). The workbook itself is fine; see SETUP_GOOGLE.md step 9 for documents and payslip PDFs.`);
    }
  }

  // humans get access to a service-account-owned spreadsheet through explicit grants
  if (!usingExisting) {
    for (const email of admins) {
      for (const [fileId, role] of [[spreadsheetId, 'writer'], ...(root ? [[root, 'reader'] as const] : [])] as const) {
        await withRetry(() => drive.permissions.create({ fileId, sendNotificationEmail: false, supportsAllDrives: true, requestBody: { type: 'user', role, emailAddress: email } })).catch((e) => console.warn(`  could not share ${fileId} with ${email}: ${e.message}`));
      }
    }
  }

  const ids = { spreadsheetId, spreadsheetUrl, driveRootFolderId: root, driveDocsFolderId: docs, drivePayslipFolderId: payslips, capacityScale: scale, createdAt: new Date().toISOString() };
  const dir = path.join(ROOT, '.local');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'google-ids.json'), JSON.stringify(ids, null, 2), 'utf8');

  console.log('\n✔ Workbook ready. Add these to .env:\n');
  console.log(`GOOGLE_SPREADSHEET_ID=${spreadsheetId}`);
  if (root) {
    console.log(`DRIVE_ROOT_FOLDER_ID=${root}`);
    console.log(`DRIVE_DOCS_FOLDER_ID=${docs}`);
    console.log(`DRIVE_PAYSLIP_FOLDER_ID=${payslips}`);
  }
  console.log(`CAPACITY_SCALE=${scale}`);
  console.log(`\nOpen it: ${spreadsheetUrl}`);
  console.log('Next: npm run google:init   then   npm run google:verify');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
