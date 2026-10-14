import { SchemaIndex, buildSchema } from '@nutex/formula-specs';
import { EmulatorGateway } from './emulator';
import { GoogleSheetsGateway, createGoogleAuth } from './google';
import type { SheetsGateway } from './gateway';
import { serialToDate } from './serial';
import type { SheetRepository } from './repository';

export interface ConnectorEnv {
  GOOGLE_SPREADSHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  NUTEX_BACKEND?: string;
  NODE_ENV?: string;
}

/**
 * NUTEX_BACKEND=google (default in production) uses the real workbook.
 * NUTEX_BACKEND=emulator is for tests / offline development only and is refused when NODE_ENV=production.
 */
export function createGateway(env: ConnectorEnv, idx: SchemaIndex = buildSchema()): SheetsGateway {
  const backend = env.NUTEX_BACKEND ?? 'google';
  if (backend === 'emulator') return new EmulatorGateway(idx);
  if (!env.GOOGLE_SPREADSHEET_ID) throw new Error('GOOGLE_SPREADSHEET_ID is not set (run npm run google:create, see SETUP_GOOGLE.md)');
  const auth = createGoogleAuth({ keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, credentialsJson: env.GOOGLE_SERVICE_ACCOUNT_JSON });
  return new GoogleSheetsGateway(env.GOOGLE_SPREADSHEET_ID, auth);
}

export interface ConfigMap { get(key: string): string | number | undefined; num(key: string, fallback?: number): number; str(key: string, fallback?: string): string; yn(key: string): boolean }

/** read a key-value tab (SYSTEM_CONFIG) as a typed map */
export async function loadConfig(repo: SheetRepository, tab: 'SYSTEM_CONFIG'): Promise<ConfigMap> {
  const rows = await repo.readAll(tab);
  const m = new Map<string, string | number>();
  for (const r of rows) if (r.value !== null) m.set(String(r.key), r.type === 'date' && typeof r.value === 'number' ? serialToDate(r.value) : r.value);
  return {
    get: (k) => m.get(k),
    num: (k, fb = 0) => { const v = m.get(k); return v === undefined ? fb : Number(v); },
    str: (k, fb = '') => { const v = m.get(k); return v === undefined ? fb : String(v); },
    yn: (k) => String(m.get(k) ?? 'N').toUpperCase() === 'Y',
  };
}
