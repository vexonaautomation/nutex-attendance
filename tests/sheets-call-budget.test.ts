import { describe, expect, it } from 'vitest';
import { buildTestSchema } from '@nutex/formula-specs';
import { EmulatorGateway, SheetRepository, type RangeUpdate, type SheetsGateway } from '@nutex/sheet-connector';
import { applySeed } from '../google/setup/apply-seed';

/** On real Google every API call costs about 0.4 s, so the number of calls per operation is the speed of the app. */
function counted(inner: SheetsGateway) {
  const calls = { reads: 0, writes: 0 };
  const gw: SheetsGateway = {
    kind: inner.kind,
    readRanges: (r: string[]) => { calls.reads++; return inner.readRanges(r); },
    writeRanges: (u: RangeUpdate[]) => { calls.writes++; return inner.writeRanges(u); },
  } as SheetsGateway;
  return { gw, calls, reset: () => { calls.reads = 0; calls.writes = 0; } };
}

async function setup() {
  const idx = buildTestSchema(80, { ATTENDANCE_EVENTS: 200, ATTENDANCE_DAILY: 150 });
  const inner = new EmulatorGateway(idx);
  await applySeed(new SheetRepository(inner, idx, { cacheTtlMs: 0, configCacheTtlMs: 0 }), idx, {});
  const c = counted(inner);
  const repo = new SheetRepository(c.gw, idx, { cacheTtlMs: 60_000, configCacheTtlMs: 60_000 });
  return { repo, ...c };
}

describe('API calls per operation', () => {
  it('a read is one call, and a repeat inside the cache window is free', async () => {
    const { repo, calls, reset } = await setup();
    await repo.readAll('EMPLOYEES');
    expect(calls.reads).toBe(1);
    reset();
    await repo.readAll('EMPLOYEES');
    await repo.getByKey('EMPLOYEES', 'E003');
    expect(calls.reads).toBe(0);
  });

  it('later reads fetch only the used rows, and rows added from outside are still found', async () => {
    const { repo, calls, reset } = await setup();
    const first = await repo.readAll('EMPLOYEES');
    repo.invalidate(); // cache gone, the end-of-data is forgotten too: a cold read again
    reset();
    expect((await repo.readAll('EMPLOYEES')).length).toBe(first.length);
    expect(calls.reads).toBe(1);
  });

  it('an audit-style append does not throw away unrelated cached tabs', async () => {
    const { repo, calls, reset } = await setup();
    await repo.readAll('EMPLOYEES');
    await repo.readAll('ROLES');
    reset();
    await repo.append('AUDIT_LOG', { audit_id: 'A-1', timestamp: '2026-09-29T10:00:00', action: 'TEST' });
    await repo.update('USERS', 'U003', { last_login_at: '2026-09-29T10:00:00' });
    const before = calls.reads;
    await repo.readAll('EMPLOYEES');
    await repo.readAll('ROLES');
    expect(calls.reads).toBe(before); // still cached
  });

  it('a write to a tab that formulas read does drop the tabs that depend on it', async () => {
    const { repo, calls, reset } = await setup();
    await repo.readAll('ATTENDANCE_DAILY');
    await repo.readAll('DASHBOARD_DATA');
    reset();
    await repo.append('ATTENDANCE_EVENTS', { event_id: 'EV-1', employee_id: 'E003', event_datetime: '2026-09-29T09:00:00', event_type: 'IN', idempotency_key: 'k1', company_id: 'CMP-NUTEX', status: 'ACTIVE' });
    reset();
    await repo.readAll('ATTENDANCE_DAILY');
    await repo.readAll('DASHBOARD_DATA');
    expect(calls.reads).toBe(2); // both re-read: their formulas read ATTENDANCE_EVENTS
  });

  it('an update of a tab without formulas is one write, no read-back; an append is one write plus one verifying read', async () => {
    const { repo, calls, reset } = await setup();
    await repo.readAll('USERS');
    reset();
    const r = await repo.update('USERS', 'U003', { display_name: 'Renamed' });
    expect(calls).toEqual({ reads: 0, writes: 1 });
    expect(r.after.display_name).toBe('Renamed');
    expect(r.before.display_name).not.toBe('Renamed');
    reset();
    await repo.append('NOTIFICATIONS', { notification_id: 'N-1', template: 'x' });
    expect(calls.writes).toBe(1);
    expect(calls.reads).toBeLessThanOrEqual(2); // end-of-data (first time) + verification
    reset();
    await repo.append('NOTIFICATIONS', { notification_id: 'N-2', template: 'x' });
    expect(calls).toEqual({ reads: 1, writes: 1 }); // the end of the data is remembered
  });

  it('an audit entry costs one call once the end of the log is known (the hash chain is its own check)', async () => {
    const { repo, calls, reset } = await setup();
    await repo.append('AUDIT_LOG', { audit_id: 'A-1', timestamp: '2026-09-29T10:00:00', action: 'T' }, { verify: false });
    reset();
    const r = await repo.append('AUDIT_LOG', { audit_id: 'A-2', timestamp: '2026-09-29T10:00:01', action: 'T' }, { verify: false });
    expect(calls).toEqual({ reads: 0, writes: 1 });
    expect(r._row).toBe(3);
    expect((await repo.readAll('AUDIT_LOG')).map((x) => x.audit_id)).toEqual(['A-1', 'A-2']);
  });

  it('several updates go out as one write', async () => {
    const { repo, calls, reset } = await setup();
    await repo.readAll('SYSTEM_CONFIG');
    reset();
    const out = await repo.updateMany('SYSTEM_CONFIG', [{ key: 'ATTENDANCE_AS_OF', patch: { value: 46000.5 } }, { key: 'DASHBOARD_DATE', patch: { value: 46000 } }]);
    expect(out).toHaveLength(2);
    expect(calls.writes).toBe(1);
  });

  it('a concurrent writer is still detected', async () => {
    const { repo } = await setup();
    await repo.append('NOTIFICATIONS', { notification_id: 'N-1', template: 'x' });
    const [a, b] = await Promise.all([
      repo.appendIfAbsent('NOTIFICATIONS', 'notification_id', { notification_id: 'N-2', template: 'x' }),
      repo.appendIfAbsent('NOTIFICATIONS', 'notification_id', { notification_id: 'N-2', template: 'x' }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await repo.readAll('NOTIFICATIONS')).filter((n) => n.notification_id === 'N-2')).toHaveLength(1);
  });
});
