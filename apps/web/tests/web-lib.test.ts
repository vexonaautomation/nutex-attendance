import { describe, expect, it } from 'vitest';
import { csvCell, inr, minutesToHm, monthRange, toCsv, toneOf } from '../lib/format';
import { inputTypeFor, toFormValues, toPayload, validate, type FieldMeta } from '../lib/forms';
import { can, visibleNav, type Perm } from '../lib/nav';
import { LocationEnv, acquireLocation, formatCoords, locationAdvice, mapUrl } from '../lib/location';
import { passwordProblem } from '../lib/password';
import { THEME, contrastRatio } from '../../../packages/ui/src';

const perm = (resource: string, ...a: Array<'read' | 'write' | 'approve' | 'export'>): Perm => ({ resource, read: a.includes('read'), write: a.includes('write'), approve: a.includes('approve'), export: a.includes('export'), scope: 'SELF' });

describe('formatting', () => {
  it('neutralises spreadsheet formula injection in CSV', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-5')).toBe('-5'); // real negative numbers stay numbers
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(toCsv([{ key: 'n', label: 'Name' }], [{ n: '@cmd' }])).toBe("Name\n'@cmd");
  });
  it('formats money, minutes and ranges', () => {
    expect(inr(34500)).toContain('34,500.00');
    expect(minutesToHm(472)).toBe('7h 52m');
    expect(minutesToHm(0)).toBe('-');
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
  it('maps statuses to tones', () => {
    expect(toneOf('PRESENT')).toBe('ok');
    expect(toneOf('MISSING_PUNCH')).toBe('bad');
    expect(toneOf('pending')).toBe('warn');
    expect(toneOf('whatever')).toBe('neutral');
  });
});

describe('schema-driven forms', () => {
  const fields: FieldMeta[] = [
    { name: 'name', kind: 'input', type: 'text', required: true, editable: true, hidden: false },
    { name: 'joined', kind: 'input', type: 'date', required: false, editable: true, hidden: false },
    { name: 'at', kind: 'input', type: 'datetime', required: false, editable: true, hidden: false },
    { name: 'amount', kind: 'input', type: 'money', required: false, editable: true, hidden: false },
    { name: 'flag', kind: 'input', type: 'yn', required: false, editable: true, hidden: false },
  ];
  it('chooses widgets by column type', () => {
    expect(fields.map(inputTypeFor)).toEqual(['text', 'date', 'datetime-local', 'number', 'select']);
  });
  it('builds a clean payload: drops blanks, casts numbers, adds seconds', () => {
    expect(toPayload(fields, { name: 'x', joined: '2026-09-01', at: '2026-09-01T09:00', amount: '12.5', flag: '' })).toEqual({ name: 'x', joined: '2026-09-01', at: '2026-09-01T09:00:00', amount: 12.5 });
  });
  it('round-trips a row into form values', () => {
    expect(toFormValues(fields, { name: 'x', at: '2026-09-01T09:00:00', amount: 3, joined: null })).toMatchObject({ name: 'x', at: '2026-09-01T09:00', amount: '3', joined: '' });
  });
  it('validates required fields, numbers and formula-looking text', () => {
    expect(validate(fields, { name: '' }).name).toBe('Required');
    expect(validate(fields, { name: 'ok', amount: 'abc' }).amount).toBe('Must be a number');
    expect(validate(fields, { name: '=SUM(1)' }).name).toMatch(/Cannot start/);
    expect(validate(fields, { name: 'ok', amount: '10' })).toEqual({});
  });
});

describe('navigation is permission aware (server still enforces)', () => {
  it('hides modules the role cannot read', () => {
    const emp = [perm('attendance', 'read', 'write'), perm('leave', 'read', 'write'), perm('payslips', 'read')];
    const hrefs = visibleNav(emp).map((n) => n.href);
    expect(hrefs).toContain('/attendance');
    expect(hrefs).toContain('/payslips');
    expect(hrefs).not.toContain('/payroll');
    expect(hrefs).not.toContain('/audit');
    expect(hrefs).toContain('/settings'); // everyone has a profile
    expect(can(emp, 'payroll', 'read')).toBe(false);
  });
});

describe('device location', () => {
  type Ok = (p: GeolocationPosition) => void;
  type Err = (e: GeolocationPositionError) => void;
  const pos = (accuracy: number, lat = 19.076, lng = 72.8777, ts = 1_000): GeolocationPosition => ({ coords: { latitude: lat, longitude: lng, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }, timestamp: ts, toJSON: () => ({}) });
  /** fake geolocation + timers: `emit` feeds fixes, `tick` fires the overall time limit */
  function rig(opts: { secure?: boolean; supported?: boolean } = {}) {
    let ok: Ok = () => undefined; let err: Err = () => undefined; let timer: (() => void) | undefined; let cleared = false;
    const env: LocationEnv = {
      isSecureContext: opts.secure ?? true,
      geolocation: opts.supported === false ? undefined : { watchPosition: (o, e) => { ok = o; err = e; return 7; }, clearWatch: () => { cleared = true; } },
      setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => undefined,
    };
    return { env, emit: (p: GeolocationPosition) => ok(p), fail: (code: number) => err({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError), tick: () => timer?.(), cleared: () => cleared };
  }

  it('resolves as soon as a fix is accurate enough and stops listening', async () => {
    const r = rig();
    const p = acquireLocation({ targetAccuracyM: 50 }, r.env);
    r.emit(pos(400)); r.emit(pos(30, 19.0761, 72.8778, 2_000));
    await expect(p).resolves.toMatchObject({ lat: 19.0761, lng: 72.8778, accuracy: 30, capturedAt: 2_000 });
    expect(r.cleared()).toBe(true);
  });
  it('keeps the best fix and reports INACCURATE with it when the time limit ends first', async () => {
    const r = rig();
    const p = acquireLocation({ targetAccuracyM: 50 }, r.env);
    r.emit(pos(900)); r.emit(pos(300)); r.emit(pos(500));
    r.tick();
    await expect(p).rejects.toMatchObject({ code: 'INACCURATE', best: { accuracy: 300 } });
  });
  it('reports TIMEOUT when nothing arrived, DENIED at once when permission is refused', async () => {
    const a = rig(); const pa = acquireLocation({ targetAccuracyM: 50 }, a.env); a.tick();
    await expect(pa).rejects.toMatchObject({ code: 'TIMEOUT' });
    const b = rig(); const pb = acquireLocation({ targetAccuracyM: 50 }, b.env); b.fail(1);
    await expect(pb).rejects.toMatchObject({ code: 'DENIED' });
  });
  it('a transient "position unavailable" does not end the wait', async () => {
    const r = rig();
    const p = acquireLocation({ targetAccuracyM: 50 }, r.env);
    r.fail(2); r.fail(3); r.emit(pos(20));
    await expect(p).resolves.toMatchObject({ accuracy: 20 });
  });
  it('refuses insecure pages and browsers without geolocation', async () => {
    await expect(acquireLocation({ targetAccuracyM: 50 }, rig({ secure: false }).env)).rejects.toMatchObject({ code: 'INSECURE' });
    await expect(acquireLocation({ targetAccuracyM: 50 }, rig({ supported: false }).env)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('gives the person a concrete next step for every failure', () => {
    expect(locationAdvice('DENIED', { secure: true, protocol: 'https:' })).toMatch(/Allow/);
    expect(locationAdvice('INSECURE', { secure: false, protocol: 'http:' })).toMatch(/https/);
    expect(locationAdvice('INACCURATE', { secure: true, protocol: 'https:' })).toMatch(/GPS/);
    expect(locationAdvice('TIMEOUT', { secure: true, protocol: 'https:' })).toMatch(/GPS/);
  });
  it('formats coordinates and map links', () => {
    expect(formatCoords(19.076012345, 72.877691)).toBe('19.076012, 72.877691');
    expect(formatCoords(null, 72)).toBe('');
    expect(mapUrl(19.076, 72.8777)).toBe('https://www.google.com/maps?q=19.076,72.8777');
  });
});

describe('password rules mirror the server', () => {
  it('needs 8+ characters with letters and digits, and not the username', () => {
    expect(passwordProblem('short1')).toMatch(/at least 8/);
    expect(passwordProblem('onlyletters')).toMatch(/letters and digits/);
    expect(passwordProblem('12345678')).toMatch(/letters and digits/);
    expect(passwordProblem('Rahul1234', 'rahul1234')).toMatch(/username/);
    expect(passwordProblem('Sunrise2026')).toBeNull();
  });
});

describe('theme accessibility', () => {
  it('body text meets WCAG AA (4.5:1) in both themes', () => {
    expect(contrastRatio(THEME.dark.text, THEME.dark.bg)).toBeGreaterThan(4.5);
    expect(contrastRatio(THEME.light.text, THEME.light.bg)).toBeGreaterThan(4.5);
    expect(contrastRatio(THEME.dark.textDim, THEME.dark.bg)).toBeGreaterThan(4.5);
    expect(contrastRatio(THEME.light.textDim, THEME.light.surface)).toBeGreaterThan(4.5);
  });
  it('primary button text is readable on the brand colour', () => {
    expect(contrastRatio(THEME.dark.brandInk, THEME.dark.brand)).toBeGreaterThan(4.5);
    expect(contrastRatio(THEME.light.brandInk, THEME.light.brand)).toBeGreaterThan(3);
  });
});
