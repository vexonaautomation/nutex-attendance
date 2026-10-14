import { beforeAll, describe, expect, it } from 'vitest';
import { ApiEnv, EMAIL, IDS, key, makeApi } from '../../../tests/api-helpers';
import { driveFolder } from '../src/drive/folders';
import { notify } from '../src/notifications/notifications';

let api: ApiEnv;
let emp: string, mgr: string, root: string, hr: string;

beforeAll(async () => {
  api = await makeApi();
  [emp, mgr, root, hr] = await Promise.all([EMAIL.emp, EMAIL.mgr, EMAIL.root, EMAIL.hr].map((e) => api.login(e)));
  await api.call(hr, 'POST', '/api/leave/accrual', { asOfDate: '2026-09-30' });
});

describe('notifications', () => {
  it('a leave application notifies the approver; the decision notifies the employee', async () => {
    const ap = await api.call(emp, 'POST', '/api/leave/applications', { leaveTypeId: IDS.lt.cl, fromDate: '2026-09-30', toDate: '2026-09-30', halfDay: 'N', reason: 'x' }, { 'idempotency-key': key() });
    expect(ap.status).toBe(200);
    const mine = await api.call(mgr, 'GET', '/api/notifications');
    expect(mine.body.some((n: any) => n.template === 'LEAVE_PENDING')).toBe(true);
    await api.call(mgr, 'POST', `/api/leave/applications/${ap.body.application.application_id}/decision`, { decision: 'APPROVED' });
    const theirs = await api.call(emp, 'GET', '/api/notifications');
    expect(theirs.body.some((n: any) => n.template === 'LEAVE_APPROVED')).toBe(true);
  });

  it('people only see their own notifications', async () => {
    const theirs = await api.call(emp, 'GET', '/api/notifications');
    expect(theirs.body.every((n: any) => n.template !== 'LEAVE_PENDING')).toBe(true);
  });

  it('a failing outbox never breaks the business action', async () => {
    const actor = { user: { userId: 'U', employeeId: IDS.emp, email: 'x', role: 'EMPLOYEE' as const, companyId: IDS.company, locationScope: [] }, requestId: 'r', source: 'TEST' };
    await expect(notify(api.ctx, actor, { recipientEmployeeId: IDS.emp, template: 'T', subject: 'S', channel: 'NOPE' as never })).resolves.toBeUndefined();
  });
});

describe('deep sheet health', () => {
  it('reports formula health and capacity, restricted to settings readers', async () => {
    const h = await api.call(root, 'GET', '/api/admin/sheet-health');
    expect(h.status).toBe(200);
    expect(h.body.backend).toBe('emulator');
    expect(h.body.formulaErrors).toBe(0);
    expect(h.body.capacity.length).toBeGreaterThan(0);
    expect((await api.call(emp, 'GET', '/api/admin/sheet-health')).status).toBe(403);
  });
});

describe('drive folders', () => {
  it('resolves a folder from config and refuses a missing id on real Google', async () => {
    expect(await driveFolder(api.ctx, 'DOCS')).toBe('local'); // emulator: placeholder is fine
    const fake = { ...api.ctx, drive: { ...api.ctx.drive, kind: 'google' as const } } as typeof api.ctx;
    await expect(driveFolder(fake, 'PAYSLIP')).rejects.toThrow(/DRIVE_PAYSLIP_FOLDER_ID is not set/);
  });
});
