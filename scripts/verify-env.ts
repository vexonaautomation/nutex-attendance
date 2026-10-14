/**
 * Validates .env without printing any secret value.
 *   npm run verify:env                 checks for the configured mode
 *   npm run verify:env -- --production stricter checks (HTTPS cookie, real secrets, Google configured)
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, env } from './lib/env';

const E = env();
const prod = process.argv.includes('--production') || E.NODE_ENV === 'production';
const problems: string[] = [];
const notes: string[] = [];

const backend = E.NUTEX_BACKEND ?? 'google';
notes.push(`backend=${backend} mode=${prod ? 'production' : 'development'}`);

if (!existsSync(path.join(ROOT, '.env'))) notes.push('no .env file (using process environment only). Run npm run setup to create one.');

const secret = E.SESSION_SECRET ?? '';
if (secret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters (npm run setup generates one)');
if (/change-me|dev-only|example|secret/i.test(secret) && prod) problems.push('SESSION_SECRET looks like a placeholder');

if (backend === 'emulator' && prod) problems.push('NUTEX_BACKEND=emulator is not allowed in production');
if (backend === 'google') {
  if (!E.GOOGLE_SPREADSHEET_ID) problems.push('GOOGLE_SPREADSHEET_ID is missing (npm run google:create prints it)');
  if (!E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !E.GOOGLE_SERVICE_ACCOUNT_JSON) problems.push('Google credentials missing: GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
  if (E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const f = path.resolve(ROOT, E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
    if (!existsSync(f)) problems.push(`GOOGLE_SERVICE_ACCOUNT_KEY_FILE not found: ${E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE}`);
    else {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { type?: string; client_email?: string; private_key?: string };
        if (j.type !== 'service_account' || !j.client_email || !j.private_key) problems.push('key file is not a service-account key');
        else notes.push(`service account: ${j.client_email}`);
      } catch { problems.push('key file is not valid JSON'); }
      if (/^(\.\.\/)*(apps|packages|google|scripts|tests|docs)\//.test(E.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)) problems.push('keep the key file outside source folders');
    }
  }
  const scale = Number(E.CAPACITY_SCALE ?? 1);
  if (!(scale > 0 && scale <= 1)) problems.push('CAPACITY_SCALE must be in (0, 1]');
}
if (prod) {
  if (E.COOKIE_SECURE === 'false') problems.push('COOKIE_SECURE must be true in production (location access also needs HTTPS)');
  if (!/^https:\/\//.test((E.CORS_ORIGIN ?? '').split(',')[0])) problems.push('CORS_ORIGIN must be an https:// origin in production');
  if (!E.COMPANY_TIMEZONE) notes.push('COMPANY_TIMEZONE not set, defaulting to Asia/Kolkata');
}

for (const n of notes) console.log(`· ${n}`);
if (problems.length) { console.error(`\n✖ ${problems.length} configuration problem(s):\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log('✔ environment OK');
