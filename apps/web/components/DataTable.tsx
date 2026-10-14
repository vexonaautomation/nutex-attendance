'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { download, toCsv } from '@/lib/format';
import { EmptyState, Loading } from './ui';
import { Icon } from './Icon';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  align?: 'num';
  sortable?: boolean;
  /** value used for sort / search / CSV when render returns JSX */
  value?: (row: T) => string | number | null | undefined;
}

export function DataTable<T extends Record<string, unknown>>({
  columns, rows, loading, searchable = true, pageSize = 15, exportName, onRowClick, empty, totals, actions, toolbar,
}: {
  columns: Column<T>[]; rows: T[] | undefined; loading?: boolean; searchable?: boolean; pageSize?: number; exportName?: string; onRowClick?: (r: T) => void;
  empty?: { title?: string; hint?: string }; totals?: Record<string, number>; actions?: ReactNode; toolbar?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);

  const val = (c: Column<T>, r: T) => (c.value ? c.value(r) : (r[c.key] as string | number | null | undefined));
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    let out = rows ?? [];
    if (s) out = out.filter((r) => columns.some((c) => String(val(c, r) ?? '').toLowerCase().includes(s)));
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      if (c) out = [...out].sort((a, b) => {
        const x = val(c, a) ?? ''; const y = val(c, b) ?? '';
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, sort, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = Math.min(page, pages);
  const slice = filtered.slice((cur - 1) * pageSize, cur * pageSize);

  if (loading && !rows) return <Loading />;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        {searchable && <input aria-label="Search" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 280 }} />}
        {toolbar}
        <span className="spacer" />
        {actions}
        {exportName && (
          <button className="btn sm" onClick={() => download(`${exportName}.csv`, toCsv(columns.map((c) => ({ key: c.key, label: c.label })), filtered.map((r) => Object.fromEntries(columns.map((c) => [c.key, val(c, r)])))))}>
            <Icon name="download" size={15} /> Export CSV
          </button>
        )}
      </div>
      {filtered.length === 0 ? <EmptyState title={q ? 'No matches' : empty?.title ?? 'No records'} hint={q ? 'Try a different search.' : empty?.hint} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={`${c.align ?? ''} ${c.sortable === false ? '' : 'sortable'}`} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                    onClick={c.sortable === false ? undefined : () => setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 }))}>
                    {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r, i) => (
                <tr key={i} className={onRowClick ? 'click' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                  {columns.map((c) => <td key={c.key} className={c.align ?? ''}>{c.render ? c.render(r) : String(r[c.key] ?? '') || <span className="muted">-</span>}</td>)}
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot><tr>{columns.map((c, i) => <td key={c.key} className={c.align ?? ''}>{i === 0 ? 'Total' : totals[c.key] !== undefined ? totals[c.key].toLocaleString('en-IN') : ''}</td>)}</tr></tfoot>
            )}
          </table>
        </div>
      )}
      {filtered.length > pageSize && (
        <div className="pager">
          <span>{(cur - 1) * pageSize + 1}-{Math.min(cur * pageSize, filtered.length)} of {filtered.length}</span>
          <button className="btn sm" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>Prev</button>
          <button className="btn sm" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
