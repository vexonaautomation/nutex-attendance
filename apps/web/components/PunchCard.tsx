'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, newKey } from '@/lib/api';
import { useFetch } from '@/hooks/useApi';
import { isoDay, minutesToHm, timeOnly } from '@/lib/format';
import { LocationError, acquireLocation, formatCoords, locationAdvice, mapUrl, type GeoFix } from '@/lib/location';
import { Badge, Card } from './ui';
import { Icon } from './Icon';

type Day = { status: string; first_in: string | null; last_out: string | null; worked_minutes: number; late_minutes: number };
type Policy = { requiresLocation: boolean; maxAccuracyM: number; branch: { name: string; geofenceRequired: boolean; radiusM: number | null; hasCoordinates: boolean } | null };
type Event = { type: 'IN' | 'OUT'; at: string; lat: number | null; lng: number | null; accuracyM: number | null; distanceM: number | null; mapUrl: string; geoStatus: string };
type Outcome = { kind: 'ok'; event: Event } | { kind: 'bad'; message: string; advice?: string };

const siteInfo = () => ({ secure: typeof isSecureContext === 'undefined' ? true : isSecureContext, protocol: typeof location === 'undefined' ? '' : location.protocol });

/**
 * Today's attendance. Check in and check out both read the device location, send it with the punch, and the server stores the
 * coordinates on the attendance event (ATTENDANCE_EVENTS in the workbook: latitude, longitude, accuracy, distance to the branch).
 */
export function PunchCard() {
  const today = isoDay();
  const policy = useFetch<Policy>('/api/attendance/policy');
  const day = useFetch<Day[]>(`/api/attendance/me?from=${today}&to=${today}`);
  const [now, setNow] = useState<Date | null>(null);
  const [phase, setPhase] = useState<'idle' | 'locating' | 'sending'>('idle');
  const [fix, setFix] = useState<GeoFix | undefined>();
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');
  const key = useRef<string>(newKey()); // reused on retry so a double tap / lost response can never create two punches

  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const sync = () => status && setPermission(status.state);
    navigator.permissions?.query({ name: 'geolocation' }).then((s) => { status = s; sync(); s.addEventListener('change', sync); }).catch(() => undefined);
    return () => status?.removeEventListener('change', sync);
  }, []);

  const d = day.data?.[0];
  const notStarted = !d || (!d.first_in && d.status === 'ABSENT');
  const hasOpenIn = !!d?.first_in && !d.last_out;
  const label = hasOpenIn ? 'Check out' : 'Check in';
  const busy = phase !== 'idle';
  const maxAccuracy = policy.data?.maxAccuracyM ?? 150;

  async function punch() {
    setOutcome(undefined); setFix(undefined);
    try {
      setPhase('locating');
      const geo = await acquireLocation({ targetAccuracyM: maxAccuracy, onProgress: setFix });
      setPhase('sending');
      const r = await api.idem<{ replayed: boolean; event: Event }>('/api/attendance/punch', {
        type: 'AUTO', method: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'MOBILE' : 'WEB',
        geo: { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy, capturedAt: geo.capturedAt },
      }, key.current);
      key.current = newKey();
      setOutcome({ kind: 'ok', event: r.event });
      day.reload();
    } catch (e) {
      if (e instanceof LocationError) setOutcome({ kind: 'bad', message: e.message, advice: locationAdvice(e.code, siteInfo()) });
      else if (e instanceof ApiError) {
        // a rejected punch (bad accuracy, outside the geofence, already checked in ...) is final: the next try is a new punch
        if (e.status !== 0) key.current = newKey();
        setOutcome({ kind: 'bad', message: e.message });
        if (e.code === 'ALREADY_CHECKED_IN' || e.code === 'NOT_CHECKED_IN') day.reload();
      } else setOutcome({ kind: 'bad', message: e instanceof Error ? e.message : 'Something went wrong' });
    } finally { setPhase('idle'); }
  }

  const branch = policy.data?.branch;
  const pct = fix ? Math.max(8, Math.min(100, Math.round((maxAccuracy / Math.max(fix.accuracy, 1)) * 100))) : 8;

  return (
    <Card title="Today">
      <div className="punch">
        <div className="time" aria-live="off">{now ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'}</div>
        <div className="row">
          <Badge value={notStarted ? 'Not checked in' : d.status} tone={notStarted ? 'neutral' : undefined} />
          {d?.first_in && <span className="muted">In {timeOnly(d.first_in)}</span>}
          {d?.last_out && <span className="muted">Out {timeOnly(d.last_out)}</span>}
          {!!d?.worked_minutes && <span className="muted">Worked {minutesToHm(d.worked_minutes)}</span>}
        </div>

        <button className={`btn primary punch-btn${busy ? ' busy' : ''}`} onClick={() => void punch()} disabled={busy || policy.loading}>
          <Icon name="pin" size={22} /> {phase === 'locating' ? 'Getting your location…' : phase === 'sending' ? 'Recording…' : label}
        </button>

        {phase === 'locating' && (
          <>
            <div className="loc-meter" role="progressbar" aria-label="Location accuracy" aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
            <p className="muted" style={{ fontSize: '0.85rem' }}>{fix ? `Accuracy about ${Math.round(fix.accuracy)} m (need ${maxAccuracy} m or better)…` : 'Waiting for the GPS. Allow location if the browser asks.'}</p>
          </>
        )}

        {permission === 'denied' && phase === 'idle' && (
          <div className="notice bad" role="alert">{locationAdvice('DENIED', siteInfo())}</div>
        )}

        {outcome?.kind === 'ok' && (
          <div className="loc-result ok" role="status">
            <strong>{outcome.event.type === 'IN' ? 'Checked in' : 'Checked out'} at {timeOnly(outcome.event.at)}</strong>
            {outcome.event.lat !== null && outcome.event.lng !== null && (
              <span className="muted">
                <Icon name="pin" size={14} /> {formatCoords(outcome.event.lat, outcome.event.lng)}
                {outcome.event.accuracyM !== null && ` (±${Math.round(outcome.event.accuracyM)} m)`}
                {outcome.event.distanceM !== null && ` · ${outcome.event.distanceM} m from ${branch?.name ?? 'your branch'}`}
                {' · '}<a href={outcome.event.mapUrl || mapUrl(outcome.event.lat, outcome.event.lng)} target="_blank" rel="noopener noreferrer">View on map</a>
              </span>
            )}
          </div>
        )}
        {outcome?.kind === 'bad' && (
          <div className="loc-result bad" role="alert">
            <strong>{outcome.message}</strong>
            {outcome.advice && <span className="muted">{outcome.advice}</span>}
          </div>
        )}

        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Your location is recorded with every check-in and check-out.
          {branch?.geofenceRequired && branch.radiusM ? ` You must be within ${branch.radiusM} m of ${branch.name}.` : ''}
          {' '}Forgot to punch? Ask your manager to approve a regularisation.
        </p>
      </div>
    </Card>
  );
}
