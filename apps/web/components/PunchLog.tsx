'use client';
import { useFetch } from '@/hooks/useApi';
import { formatCoords, mapUrl } from '@/lib/location';
import { qs } from '@/lib/api';
import { label } from '@/lib/format';
import { DataTable } from './DataTable';
import { Badge, ErrorState } from './ui';

export type PunchEvent = {
  eventId: string; employeeId: string; employeeName: string; at: string; type: 'IN' | 'OUT'; method: string; geoStatus: string;
  lat: number | null; lng: number | null; accuracyM: number | null; distanceM: number | null; mapUrl: string; notes?: string;
};

/** every check-in / check-out with the coordinates the device reported (the same values are stored in ATTENDANCE_EVENTS) */
export function PunchLog({ from, to, employeeId, showEmployee = true, exportName = 'punch-locations' }: { from: string; to: string; employeeId?: string; showEmployee?: boolean; exportName?: string }) {
  const ev = useFetch<PunchEvent[]>(`/api/attendance/events${qs({ from, to, employeeId })}`);
  if (ev.error) return <ErrorState error={ev.error} onRetry={ev.reload} />;
  return (
    <DataTable<PunchEvent> rows={ev.data} loading={ev.loading} exportName={exportName} pageSize={20}
      columns={[
        ...(showEmployee ? [{ key: 'employeeName', label: 'Employee' }] : []),
        { key: 'at', label: 'Time', render: (r) => String(r.at ?? '').replace('T', ' ') },
        { key: 'type', label: 'Type', render: (r) => <Badge value={r.type} tone={r.type === 'IN' ? 'ok' : 'info'} /> },
        { key: 'lat', label: 'Latitude', align: 'num', render: (r) => (r.lat === null ? <span className="muted">-</span> : r.lat.toFixed(6)) },
        { key: 'lng', label: 'Longitude', align: 'num', render: (r) => (r.lng === null ? <span className="muted">-</span> : r.lng.toFixed(6)) },
        { key: 'accuracyM', label: 'Accuracy (m)', align: 'num', render: (r) => (r.accuracyM === null ? <span className="muted">-</span> : `±${Math.round(r.accuracyM)}`) },
        { key: 'distanceM', label: 'From branch (m)', align: 'num', render: (r) => (r.distanceM === null ? <span className="muted">-</span> : r.distanceM) },
        { key: 'geoStatus', label: 'Geofence', render: (r) => (r.geoStatus === 'NOT_REQUIRED' ? <span className="muted">not required</span> : <Badge value={r.geoStatus} tone={r.geoStatus === 'INSIDE' ? 'ok' : 'bad'} />) },
        { key: 'method', label: 'Via', render: (r) => label(r.method) },
        { key: 'mapUrl', label: 'Map', sortable: false, value: (r) => (r.lat === null || r.lng === null ? '' : formatCoords(r.lat, r.lng)), render: (r) => (r.lat === null || r.lng === null ? <span className="muted">-</span> : <a href={r.mapUrl || mapUrl(r.lat, r.lng)} target="_blank" rel="noopener noreferrer">Open map</a>) },
      ]} />
  );
}
