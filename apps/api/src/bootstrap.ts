import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildScaledSchema, buildSchema, buildTestSchema, type SchemaIndex } from '@nutex/formula-specs';
import { EmulatorGateway, GoogleSheetsGateway, SheetRepository, createGoogleAuth, type SheetsGateway } from '@nutex/sheet-connector';
import { GoogleDriveStore, LocalDriveStore, MemoryDriveStore, type DriveStore } from '@nutex/drive-connector';
import { generatePassword, hashPassword } from '@nutex/validation';
import { applySeed } from '../../../google/setup/apply-seed';
import { SEED_USERS } from '../../../google/setup/seed-data';
import { AppContext, Env, createContext, loadEnv } from './common/core';

export async function createProductionContext(src: Record<string, string | undefined> = process.env): Promise<AppContext> {
  const env = loadEnv(src);
  const idx = buildScaledSchema(Number(src.CAPACITY_SCALE ?? 1));
  if (!src.GOOGLE_SPREADSHEET_ID) throw new Error('GOOGLE_SPREADSHEET_ID is not set. Run `npm run google:create` and copy the id into .env (see SETUP_GOOGLE.md).');
  const cfg = { keyFile: src.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: src.GOOGLE_SERVICE_ACCOUNT_JSON };
  const gateway: SheetsGateway = new GoogleSheetsGateway(src.GOOGLE_SPREADSHEET_ID, createGoogleAuth(cfg));
  // Google allows 60 reads / minute / user / project and every call costs ~0.4 s: a longer read cache is the main lever. Writes through this API
  // drop exactly the tabs they can change, so the TTL only matters for edits made by hand in the sheet (visible after at most this long).
  const repo = new SheetRepository(gateway, idx, { cacheTtlMs: Number(src.READ_CACHE_TTL_MS ?? 30_000), configCacheTtlMs: 60_000 });
  const drive: DriveStore = new GoogleDriveStore(cfg);
  return createContext({ repo, idx, drive, env });
}

export interface EmulatorOptions {
  rows?: number;
  big?: Record<string, number>;
  env?: Partial<Env>;
  now?: () => Date;
  /** password used for every seeded demo user; random per user when omitted */
  password?: string;
  full?: boolean;
  credentialsFile?: string;
  /**
   * LOCAL TESTING ONLY: also create the login `admin` with password `admin` (SUPER_ADMIN, linked to employee E001).
   * The emulator backend is refused in production, so this account can never exist in a real deployment.
   */
  devAdmin?: boolean;
}

export const DEV_ADMIN = { userId: 'U000', loginId: 'admin', password: '123', employeeId: 'E001' } as const;

/** offline development / tests: HyperFormula-backed spreadsheet + in-memory Drive. Never use in production. */
export async function createEmulatorContext(o: EmulatorOptions = {}): Promise<{ ctx: AppContext; passwords: Record<string, string>; idx: SchemaIndex; gateway: EmulatorGateway }> {
  if (process.env.NODE_ENV === 'production') throw new Error('Emulator backend is not allowed in production');
  const idx = o.full ? buildSchema() : buildTestSchema(o.rows ?? 120, o.big ?? {});
  const gateway = new EmulatorGateway(idx);
  const repo = new SheetRepository(gateway, idx, { cacheTtlMs: 0, configCacheTtlMs: 0 });
  const passwords: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const u of SEED_USERS) {
    passwords[u.email] = o.password ?? generatePassword();
    hashes[u.email] = await hashPassword(passwords[u.email]);
  }
  await applySeed(repo, idx, hashes);
  if (o.devAdmin) {
    const now = '2026-09-01T00:00:00';
    await repo.append('USERS', {
      user_id: DEV_ADMIN.userId, employee_id: DEV_ADMIN.employeeId, email: DEV_ADMIN.loginId, display_name: 'Admin (local test)', password_hash: await hashPassword(DEV_ADMIN.password),
      role: 'SUPER_ADMIN', location_scope: 'ALL', mfa_enabled: 'N', failed_attempts: 0, must_change_password: 'N', company_id: 'CMP-NUTEX', created_at: now, created_by: 'dev', updated_at: now, updated_by: 'dev', source: 'DEV', request_id: 'dev', status: 'ACTIVE',
    });
    passwords[DEV_ADMIN.loginId] = DEV_ADMIN.password;
  }
  const drive = o.credentialsFile ? new LocalDriveStore(path.join(path.dirname(o.credentialsFile), 'drive')) : new MemoryDriveStore();
  const env = { ...loadEnv({ NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV ?? 'test') }), ...o.env };
  const ctx = createContext({ repo, idx, drive, env, now: o.now });
  if (o.credentialsFile) {
    await mkdir(path.dirname(o.credentialsFile), { recursive: true });
    const lines = [...(o.devAdmin ? [`${'SUPER_ADMIN'.padEnd(20)} ${DEV_ADMIN.loginId.padEnd(38)} ${DEV_ADMIN.password}   (local test login)`] : []), ...SEED_USERS.map((u) => `${u.role.padEnd(20)} ${u.email.padEnd(38)} ${passwords[u.email]}`)];
    await writeFile(o.credentialsFile, `NUTEX demo credentials (emulator backend, regenerated on every start)\n\n${lines.join('\n')}\n`, 'utf8');
  }
  return { ctx, passwords, idx, gateway };
}
