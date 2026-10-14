import { describe, expect, it } from 'vitest';
import { GoogleSheetsGateway, KeyedMutex, ReadCache, SheetRepository, EmulatorGateway, createGoogleAuth, isRetryable, withRetry, CapacityError } from '@nutex/sheet-connector';
import { buildTestSchema } from '@nutex/formula-specs';

const http = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { code: status, ...extra });

describe('retry with exponential backoff (Google 429 / transient errors)', () => {
  it('retries 429 with doubling delays and succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const out = await withRetry(async () => { if (++n < 4) throw http(429); return 'ok'; }, { sleep: async (ms) => { delays.push(ms); }, random: () => 0, baseMs: 500 });
    expect(out).toBe('ok');
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('caps the delay, gives up after the retry budget and surfaces the error', async () => {
    const delays: number[] = [];
    await expect(withRetry(async () => { throw http(503); }, { retries: 4, baseMs: 10_000, maxMs: 15_000, random: () => 0, sleep: async (ms) => { delays.push(ms); } })).rejects.toThrow('HTTP 503');
    expect(delays).toEqual([10_000, 15_000, 15_000, 15_000]);
  });

  it('does not retry client errors', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw http(400); }, { sleep: async () => undefined })).rejects.toThrow('HTTP 400');
    expect(n).toBe(1);
    expect(isRetryable(http(403))).toBe(false);
    expect(isRetryable(http(403, { errors: [{ reason: 'rateLimitExceeded' }] }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('GoogleSheetsGateway retries a quota error on batchGet and reports it in stats', async () => {
    const gw = new GoogleSheetsGateway('sheet-id', createGoogleAuth({ credentialsJson: JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAtest\n-----END PRIVATE KEY-----\n' }) }), { sleep: async () => undefined, random: () => 0 });
    let calls = 0;
    (gw as unknown as { sheets: unknown }).sheets = {
      spreadsheets: { values: { batchGet: async () => { if (++calls < 3) throw http(429); return { data: { valueRanges: [{ values: [['a', 1]] }] } }; } } },
    };
    const [rows] = await gw.readRanges(['EMPLOYEES!A2:C2']);
    expect(rows).toEqual([['a', 1, null]]); // padded to the requested width
    expect(calls).toBe(3);
    expect(gw.stats.retries).toBe(2);
  });

  it('GoogleSheetsGateway writes with RAW so "=..." typed by a user is never evaluated', async () => {
    const gw = new GoogleSheetsGateway('sheet-id', createGoogleAuth({ credentialsJson: JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: 'k' }) }));
    let sent: any;
    (gw as unknown as { sheets: unknown }).sheets = { spreadsheets: { values: { batchUpdate: async (a: unknown) => { sent = a; return {}; } } } };
    await gw.writeRanges([{ range: 'HOLIDAYS!A2:B2', values: [['H1', '=IMPORTXML("http://evil")']] }]);
    expect(sent.requestBody.valueInputOption).toBe('RAW');
  });
});

describe('concurrency and duplicate prevention', () => {
  it('KeyedMutex serialises work per key', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([1, 2, 3].map((i) => m.run('k', async () => { order.push(`s${i}`); await new Promise((r) => setTimeout(r, 5)); order.push(`e${i}`); })));
    expect(order).toEqual(['s1', 'e1', 's2', 'e2', 's3', 'e3']);
  });

  it('parallel appends never overwrite each other (each gets its own row)', async () => {
    const idx = buildTestSchema(40);
    const repo = new SheetRepository(new EmulatorGateway(idx), idx, { cacheTtlMs: 0 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => repo.append('DEPARTMENTS', { department_id: `D${i}`, name: `Dept ${i}` })));
    const rows = await repo.readAll('DEPARTMENTS');
    expect(rows.map((r) => r.department_id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `D${i}`).sort());
  });

  it('parallel idempotent appends with the same key create one row', async () => {
    const idx = buildTestSchema(40);
    const repo = new SheetRepository(new EmulatorGateway(idx), idx, { cacheTtlMs: 0 });
    const rs = await Promise.all(Array.from({ length: 8 }, () => repo.appendIfAbsent('DEPARTMENTS', 'code', { department_id: `D-${Math.random()}`, code: 'SAME', name: 'x' })));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await repo.readAll('DEPARTMENTS')).toHaveLength(1);
  });

  it('writes can never target formula columns or unknown columns, and text is stored literally', async () => {
    const idx = buildTestSchema(40);
    const repo = new SheetRepository(new EmulatorGateway(idx), idx, { cacheTtlMs: 0 });
    await expect(repo.append('HOLIDAYS', { holiday_id: 'H1', holiday_date: '2026-10-02', name: 'x', effective_date: 5 })).rejects.toThrow(/formula column/);
    await expect(repo.append('HOLIDAYS', { holiday_id: 'H1', holiday_date: '2026-10-02', name: 'x', nope: 1 })).rejects.toThrow(/unknown column/);
    const row = await repo.append('HOLIDAYS', { holiday_id: 'H2', holiday_date: '2026-10-02', name: '=SUM(1,1)' });
    expect(row.name).toBe('=SUM(1,1)'); // stored as text, not evaluated
  });

  it('reports a clear error when a tab reaches formula capacity', async () => {
    const idx = buildTestSchema(40, { DEPARTMENTS: 3 });
    const repo = new SheetRepository(new EmulatorGateway(idx), idx, { cacheTtlMs: 0 });
    await repo.appendMany('DEPARTMENTS', [1, 2, 3].map((i) => ({ department_id: `D${i}`, name: 'n' })));
    await expect(repo.append('DEPARTMENTS', { department_id: 'D4', name: 'n' })).rejects.toBeInstanceOf(CapacityError);
  });

  it('read cache coalesces concurrent reads (protects the Sheets read quota)', async () => {
    let loads = 0;
    const c = new ReadCache<number>(1000);
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.get('k', async () => { loads++; await new Promise((r) => setTimeout(r, 5)); return 42; })));
    expect(rs.every((v) => v === 42)).toBe(true);
    expect(loads).toBe(1);
  });

  it('the emulator refuses to run in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(() => new EmulatorGateway(buildTestSchema(10))).toThrow(/production/); } finally { process.env.NODE_ENV = prev; }
  });
});
