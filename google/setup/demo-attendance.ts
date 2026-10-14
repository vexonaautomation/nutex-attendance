import { IDS } from './seed-data';

/**
 * Synthetic demo punches (deterministic PRNG). This is DATA generation for demos and screenshots, not business logic:
 * every attendance result is still derived from these raw events by the sheet formulas.
 */
function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (mins: number) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}:00`;

function isoDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface DemoEvent {
  employee_id: string; event_datetime: string; event_type: 'IN' | 'OUT'; capture_method: string; idempotency_key: string;
  geo_lat: number; geo_lng: number; geo_accuracy: number; geo_status: 'NOT_REQUIRED'; geo_distance_m: number;
}

/** the demo HQ (LOCATIONS seed): demo punches scatter within roughly 100 m of it */
const HQ = { lat: 19.076, lng: 72.8777 };
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function demoEvents(from = '2026-09-01', to = '2026-09-28'): DemoEvent[] {
  const rnd = prng(20260929);
  const geoRnd = prng(20260930); // separate stream: coordinates never change which days are absent or late
  const holidays = new Set(['2026-09-14']);
  const day: Array<{ id: string; join?: string; exit?: string }> = [
    { id: IDS.hr }, { id: IDS.mgr }, { id: IDS.emp }, { id: IDS.joiner, join: '2026-09-16' }, { id: IDS.leaver, exit: '2026-09-20' }, { id: IDS.fin }, { id: IDS.oper },
  ];
  const out: DemoEvent[] = [];
  const push = (id: string, dt: string, type: 'IN' | 'OUT', method: string) => {
    const dLat = (geoRnd() - 0.5) * 0.0016;
    const dLng = (geoRnd() - 0.5) * 0.0016;
    const metres = Math.hypot(dLat * 110_540, dLng * 111_320 * Math.cos((HQ.lat * Math.PI) / 180));
    out.push({
      employee_id: id, event_datetime: dt, event_type: type, capture_method: method, idempotency_key: `demo:${id}:${dt}:${type}`,
      geo_lat: round(HQ.lat + dLat, 6), geo_lng: round(HQ.lng + dLng, 6), geo_accuracy: 5 + Math.floor(geoRnd() * 30), geo_status: 'NOT_REQUIRED', geo_distance_m: Math.round(metres),
    });
  };
  for (const d of isoDates(from, to)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(d)) continue;
    for (const e of day) {
      if (e.join && d < e.join) continue;
      if (e.exit && d > e.exit) continue;
      const roll = rnd();
      if (roll < 0.03) continue; // absent
      const late = roll < 0.12 ? 15 + Math.floor(rnd() * 40) : 0;
      const inMin = 8 * 60 + 50 + Math.floor(rnd() * 14) + late;
      const outMin = 18 * 60 + Math.floor(rnd() * 45);
      void rnd(); // kept so the demo attendance pattern (absences, late arrivals) stays identical to earlier versions
      const method = geoRnd() < 0.7 ? 'MOBILE' : 'WEB';
      push(e.id, `${d}T${hhmm(inMin)}`, 'IN', method);
      push(e.id, `${d}T${hhmm(outMin)}`, 'OUT', method);
    }
    // night shift (Mon-Sat): 22:00 -> 06:00 next day
    if (dow !== 0) {
      const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      push(IDS.night, `${d}T${hhmm(21 * 60 + 55 + Math.floor(rnd() * 12))}`, 'IN', 'MOBILE');
      push(IDS.night, `${next}T${hhmm(6 * 60 + Math.floor(rnd() * 25))}`, 'OUT', 'MOBILE');
    }
  }
  return out;
}
