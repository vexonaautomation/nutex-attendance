import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { NAV, visibleNav, type Perm } from '../lib/nav';

const header = (r: { headers: Array<{ key: string; value: string }> }, k: string) => r.headers.find((h) => h.key === k)?.value ?? '';

describe('security headers allow location (check-in) and nothing else sensitive', () => {
  it('EVERY route rule lets the page read the device location, and never the camera or microphone', async () => {
    const rules = await nextConfig.headers!();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      const pp = header(r, 'Permissions-Policy');
      expect(pp, `rule ${r.source}`).toContain('geolocation=(self)');
      expect(pp).toContain('camera=()');
      expect(pp).toContain('microphone=()');
    }
  });

  it('the CSP stays strict: no WebAssembly compilation, no third-party connections, no framing', async () => {
    for (const r of await nextConfig.headers!()) {
      const csp = header(r, 'Content-Security-Policy');
      expect(csp).not.toContain('wasm-unsafe-eval');
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it('the navigation has no face or kiosk entries any more', () => {
    expect(NAV.map((n) => n.href).filter((h) => /face|kiosk/.test(h))).toEqual([]);
  });

  it('the attendance page (where check-in lives) is reachable with the attendance permission alone', () => {
    const p: Perm[] = [{ resource: 'attendance', read: true, write: true, approve: false, export: false, scope: 'SELF' }];
    expect(visibleNav(p).map((n) => n.href)).toContain('/attendance');
  });
});
