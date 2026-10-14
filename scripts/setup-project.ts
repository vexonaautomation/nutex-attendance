/**
 * One-command local setup: creates .env with freshly generated secrets (never printed), generates the schema artefacts and
 * tells you the next steps. Safe to re-run: it never overwrites an existing .env.
 *
 *   npm run setup
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/env';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error(`✖ Node 20+ required (found ${process.versions.node})`); process.exit(1); }

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  console.log('· .env already exists, leaving it untouched');
} else {
  const tpl = readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
  writeFileSync(envFile, tpl, { encoding: 'utf8', mode: 0o600 });
  console.log('· created .env with generated SESSION_SECRET (value not shown)');
}

const gen = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'scripts', 'generate-schema.ts')], { stdio: 'inherit' });
if (gen.status !== 0) process.exit(gen.status ?? 1);

console.log(`
Next steps
  Offline demo (no Google needed):   npm run dev:api     (emulator backend, demo logins in .local/seed-credentials.txt)
                                     npm run dev:web     (http://localhost:3000)
  Real Google Sheets:                follow SETUP_GOOGLE.md, then
                                     npm run google:create -> add ids to .env -> npm run google:init -> npm run google:verify
`);
