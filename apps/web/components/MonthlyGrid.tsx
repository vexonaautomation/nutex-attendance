'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Card, ErrorState, Loading } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useAction, useFetch } from '@/hooks/useApi';
import { download, toCsv } from '@/lib/format';

interface Totals { present: number; absent: number; leave: number; totalDays: number; weekOff: number; overtimeHours: number }
interface GridRow { sNo: number; employeeId: string; employeeCode: string; name: string; cells: string[]; totals: Totals }
interface Grid { year: number; month: number; key: string; title: string; monthName: string; days: number; source: 'live' | 'sheet'; complete: boolean; savedAt: string | null; rows: GridRow[] }
interface MonthInfo { key: string; title: string; year: number; month: number; status: 'open' | 'complete' | 'saved'; url: string | null }

const LEGEND: Array<[string, string]> = [['P', 'Present'], ['HD', 'Half day'], ['A', 'Absent'], ['L', 'Paid leave'], ['UL', 'Unpaid leave'], ['W', 'Week off'], ['WP', 'Worked on week off'],
  ['H', 'Holiday'], ['HP', 'Worked on holiday'], ['WFH', 'Work from home / on duty'], ['M', 'Missing punch'], ['IN', 'Checked in, not out yet']];
const STATE: Record<MonthInfo['status'], string> = { open: 'running', complete: 'over, not saved yet', saved: 'saved' };

/** Monthly attendance grid: one row per employee, one column per day, month totals. A finished month is a frozen tab of the workbook. */
export function MonthlyGrid() {
  const months = useFetch<MonthInfo[]>('/api/attendance/monthly/months');
  const [key, setKey] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (!key && months.data?.length) setKey(months.data[0].key); }, [months.data, key]);
  const current = months.data?.find((m) => m.key === key);
  const grid = useFetch<Grid>(current ? `/api/attendance/monthly?year=${current.year}&month=${current.month}` : null);
  const g = grid.data;

  const csv = useMemo(() => {
    if (!g) return '';
    const cols = [{ key: 'sNo', label: 'S.No' }, { key: 'name', label: 'Employee Name' }, { key: 'code', label: 'Emp ID' },
      ...Array.from({ length: g.days }, (_, i) => ({ key: `d${i + 1}`, label: String(i + 1) })),
      { key: 'present', label: 'Total Present' }, { key: 'absent', label: 'Total Absent' }, { key: 'leave', label: 'Total Leave Days' },
      { key: 'totalDays', label: 'Total Days' }, { key: 'weekOff', label: 'Total Week Off' }, { key: 'ot', label: 'Over Time (hrs)' }];
    const rows = g.rows.map((r) => ({
      sNo: r.sNo, name: r.name, code: r.employeeCode, ...Object.fromEntries(r.cells.map((c, i) => [`d${i + 1}`, c])),
      present: r.totals.present, absent: r.totals.absent, leave: r.totals.leave, totalDays: r.totals.totalDays, weekOff: r.totals.weekOff, ot: r.totals.overtimeHours,
    }));
    return toCsv(cols, rows);
  }, [g]);

  const save = async () => {
    if (!current) return;
    const done = await run(() => api.post('/api/attendance/monthly/save', { year: current.year, month: current.month }), `${current.title} saved as its own tab`);
    if (done) { months.reload(); grid.reload(); }
  };

  if (months.error) return <ErrorState error={months.error} onRetry={months.reload} />;
  return (
    <Card title="Monthly attendance grid"
      actions={(
        <span className="row" style={{ flexWrap: 'wrap' }}>
          <select aria-label="Month" value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 'auto', minWidth: 190 }}>
            {months.data?.map((m) => <option key={m.key} value={m.key}>{m.title} ({STATE[m.status]})</option>)}
          </select>
          {current?.status === 'complete' && <button className="btn" disabled={busy} onClick={save}>Save as tab</button>}
          {current?.url && <a className="btn" href={current.url} target="_blank" rel="noreferrer">Open in Google Sheets</a>}
          <button className="btn" disabled={!g?.rows.length} onClick={() => g && download(`attendance-${g.title.replace(' ', '-')}.csv`, csv)}><Icon name="download" size={15} /> Export CSV</button>
        </span>
      )}>
      {grid.error ? <ErrorState error={grid.error} onRetry={grid.reload} /> : !g ? <Loading rows={6} /> : (
        <>
          <p className="muted" style={{ marginBottom: 10 }}>
            {g.source === 'sheet'
              ? <>Saved copy of <b>{g.title}</b>{g.savedAt ? <> from {g.savedAt.replace('T', ' ')}</> : null}: a frozen tab of the workbook, later corrections do not change it.</>
              : <>Live view of <b>{g.title}</b>, straight from the sheet daily results. {g.complete ? 'The month is over: save it as its own tab.' : 'It becomes its own tab automatically when the month is over.'}</>}
            {' '}<Badge value={g.source === 'sheet' ? 'SAVED' : 'LIVE'} tone={g.source === 'sheet' ? 'ok' : 'info'} />
          </p>
          {!g.rows.length ? <p className="muted">No attendance rows for this month yet.</p> : (
            <div className="table-wrap grid-wrap">
              <table className="att-grid">
                <thead>
                  <tr>
                    <th className="stick s1">S.No</th><th className="stick s2">Employee Name</th><th className="stick s3">Emp ID</th>
                    {Array.from({ length: g.days }, (_, i) => <th key={i} className="day">{i + 1}</th>)}
                    <th>Total Present</th><th>Total Absent</th><th>Total Leave Days</th><th>Total Days</th><th>Total Week Off</th><th>Over Time (hrs)</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.employeeId}>
                      <td className="stick s1 num">{r.sNo}</td><td className="stick s2">{r.name}</td><td className="stick s3">{r.employeeCode}</td>
                      {r.cells.map((c, i) => <td key={i} className={`day gc gc-${c || 'none'}`} title={`${r.name}, ${i + 1} ${g.monthName}`}>{c}</td>)}
                      <td className="num">{r.totals.present}</td><td className="num">{r.totals.absent}</td><td className="num">{r.totals.leave}</td>
                      <td className="num">{r.totals.totalDays}</td><td className="num">{r.totals.weekOff}</td><td className="num">{r.totals.overtimeHours || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {LEGEND.map(([c, label]) => <span key={c} className="legend-item"><span className={`gc gc-${c}`}>{c}</span> {label}</span>)}
          </div>
        </>
      )}
    </Card>
  );
}
