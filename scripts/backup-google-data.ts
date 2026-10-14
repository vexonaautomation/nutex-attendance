/**
 * Backup / export of the master spreadsheet and Drive folder metadata.
 *
 *   npm run backup                       full copy in Drive + JSON export of every tab + Drive metadata under backups/<timestamp>/
 *   npm run backup -- --prune            also delete local exports older than BACKUP_RETENTION_DAYS (default 90)
 *
 * The local export contains payroll and HR data: store it encrypted, restrict access, and apply your retention policy.
 * Binary files themselves are not copied (Drive is the store); their ids, names, sizes and checksums are listed so a restore can be verified.
 */
import { google } from 'googleapis';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildScaledSchema, colLetter } from '@nutex/formula-specs';
import { GoogleSheetsGateway, createGoogleAuth, withRetry } from '@nutex/sheet-connector';
import { ROOT, env, fail } from './lib/env';

const E = env();

async function main() {
  if (!E.GOOGLE_SPREADSHEET_ID) fail('GOOGLE_SPREADSHEET_ID is not set');
  const auth = createGoogleAuth({ keyFile: E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: E.GOOGLE_SERVICE_ACCOUNT_JSON });
  const idx = buildScaledSchema(Number(E.CAPACITY_SCALE ?? 1));
  const gw = new GoogleSheetsGateway(E.GOOGLE_SPREADSHEET_ID, auth);
  const drive = google.drive({ version: 'v3', auth });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'backups', stamp);
  await mkdir(dir, { recursive: true });

  // 1) full spreadsheet copy inside Drive
  const parent = E.DRIVE_BACKUP_FOLDER_ID ?? E.DRIVE_ROOT_FOLDER_ID;
  const copy = await withRetry(() => drive.files.copy({ fileId: E.GOOGLE_SPREADSHEET_ID!, requestBody: { name: `NUTEX backup ${stamp}`, parents: parent ? [parent] : undefined }, fields: 'id,name' }));
  console.log(`· Drive copy: ${copy.data.name} (${copy.data.id})`);

  // 2) values export per tab (unformatted, so dates stay serials)
  const tabs = idx.tabs;
  const manifest: Record<string, { rows: number; columns: number }> = {};
  for (const t of tabs) {
    const [grid] = await gw.readRanges([`${t.name}!A1:${colLetter(t.columns.length - 1)}${idx.rowsFor(t) + 1}`]);
    const used = grid.filter((r, i) => i === 0 || r.some((c) => c !== null && c !== ''));
    await writeFile(path.join(dir, `${t.name}.json`), JSON.stringify({ headers: used[0], rows: used.slice(1) }), 'utf8');
    manifest[t.name] = { rows: used.length - 1, columns: t.columns.length };
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`· exported ${tabs.length} tabs`);

  // 3) Drive folder metadata
  const folders = ['DRIVE_DOCS_FOLDER_ID', 'DRIVE_PAYSLIP_FOLDER_ID'].map((k) => [k, E[k]] as const).filter(([, v]) => v);
  const meta: Record<string, unknown[]> = {};
  for (const [k, id] of folders) {
    const files: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const r = await withRetry(() => drive.files.list({ q: `'${id}' in parents and trashed = false`, fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime)', pageSize: 500, pageToken }));
      files.push(...(r.data.files ?? []));
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
    meta[k] = files;
  }
  await writeFile(path.join(dir, 'drive-metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), spreadsheetId: E.GOOGLE_SPREADSHEET_ID, driveCopyId: copy.data.id, tabs: manifest }, null, 2), 'utf8');
  console.log(`✔ backup written to ${dir}`);

  if (process.argv.includes('--prune')) {
    const keepDays = Number(E.BACKUP_RETENTION_DAYS ?? 90);
    const root = path.join(ROOT, 'backups');
    for (const d of await readdir(root)) {
      const s = await stat(path.join(root, d));
      if (Date.now() - s.mtimeMs > keepDays * 86_400_000) { await rm(path.join(root, d), { recursive: true, force: true }); console.log(`· pruned ${d}`); }
    }
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
