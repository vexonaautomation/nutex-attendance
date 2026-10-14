/**
 * Device location for check-in / check-out. The browser Geolocation API is the source; the API server validates what it receives
 * (accuracy, freshness, geofence) and stores the coordinates with the punch.
 */
export interface GeoFix { lat: number; lng: number; accuracy: number; /** ms since epoch, taken from the device fix itself */ capturedAt: number }

export type LocationErrorCode = 'UNSUPPORTED' | 'INSECURE' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'INACCURATE';

export class LocationError extends Error {
  constructor(public code: LocationErrorCode, message: string, public best?: GeoFix) {
    super(message);
    this.name = 'LocationError';
  }
}

interface WatchApi {
  watchPosition(ok: (p: GeolocationPosition) => void, err: (e: GeolocationPositionError) => void, o?: PositionOptions): number;
  clearWatch(id: number): void;
}

export interface LocationEnv {
  geolocation?: WatchApi;
  isSecureContext?: boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

const browserEnv = (): LocationEnv => ({
  geolocation: typeof navigator !== 'undefined' && 'geolocation' in navigator ? navigator.geolocation : undefined,
  isSecureContext: typeof isSecureContext === 'undefined' ? true : isSecureContext,
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

export interface AcquireOptions {
  /** stop as soon as a fix at least this accurate arrives */
  targetAccuracyM: number;
  /** give up after this long and report the best fix seen */
  timeoutMs?: number;
  onProgress?: (fix: GeoFix) => void;
}

/**
 * Listens to the GPS until a fix accurate enough arrives. A phone often reports a coarse network position first and refines it over a
 * few seconds, so the first reading is not taken blindly: the best one within the time limit wins. Never reuses a cached position.
 */
export function acquireLocation(o: AcquireOptions, env: LocationEnv = browserEnv()): Promise<GeoFix> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    if (env.isSecureContext === false) return reject(new LocationError('INSECURE', 'Location needs a secure (https) connection.'));
    if (!env.geolocation) return reject(new LocationError('UNSUPPORTED', 'This browser cannot provide your location.'));
    let best: GeoFix | undefined;
    let settled = false;
    let watchId = 0;
    // the timer callback runs later, by which time `finish` exists
    const timer = env.setTimeout(() => finish(() => {
      if (!best) return reject(new LocationError('TIMEOUT', 'Could not get your location in time.'));
      reject(new LocationError('INACCURATE', `Your location is only accurate to about ${Math.round(best.accuracy)} m.`, best));
    }), timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      env.clearTimeout(timer);
      env.geolocation?.clearWatch(watchId);
      fn();
    };
    watchId = env.geolocation.watchPosition(
      (p) => {
        const fix: GeoFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : 9999, capturedAt: p.timestamp || Date.now() };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        o.onProgress?.(best);
        if (best.accuracy <= o.targetAccuracyM) finish(() => resolve(best!));
      },
      (e) => {
        // 2 (position unavailable) and 3 (timeout) can be transient while the GPS warms up: keep listening until our own timer ends
        if (e.code === 1) finish(() => reject(new LocationError('DENIED', 'Location permission was denied.')));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
  });
}

export interface SiteInfo { secure: boolean; protocol: string }

/** what the person holding the phone should do next */
export function locationAdvice(code: LocationErrorCode, site: SiteInfo): string {
  switch (code) {
    case 'INSECURE':
      return site.protocol === 'http:'
        ? 'This page is not secure (http), and browsers only share location on https. Open the https:// address of the site.'
        : 'The browser does not treat this page as secure. Reopen the https:// address of the site.';
    case 'UNSUPPORTED': return 'This browser cannot share location. Use the latest Chrome, Edge, Safari or Firefox.';
    case 'DENIED': return 'Location is blocked for this site. Tap the lock or settings icon next to the address, set Location to Allow, then reload. Also check the phone: Settings > Location must be on.';
    case 'TIMEOUT': return 'No location was received. Turn on GPS / Location in the phone settings, go near a window or outside, and try again.';
    case 'INACCURATE': return 'The position is too rough to record. Turn on precise location / GPS (not only Wi-Fi), go near a window or outside, and try again.';
    default: return 'Location is not available right now. Check that Location is on for the phone and the browser, then try again.';
  }
}

export const mapUrl = (lat: number, lng: number): string => `https://www.google.com/maps?q=${lat},${lng}`;

/** 19.076012, 72.877691 */
export const formatCoords = (lat: number | null | undefined, lng: number | null | undefined): string =>
  lat === null || lat === undefined || lng === null || lng === undefined ? '' : `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
