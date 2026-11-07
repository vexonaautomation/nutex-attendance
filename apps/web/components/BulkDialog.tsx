'use client';
import { useRef, useState } from 'react';
import { api, ApiError, downloadFile } from '@/lib/api';
import { Badge, Modal, useToast } from '@/components/ui';
import { Icon } from '@/components/Icon';

type Kind = 'employees' | 'salaries';
interface RowResult { row: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'; changes: string[]; errors: string[] }
interface Result { applied: boolean; total: number; created: number; updated: number; unchanged: number; errorCount: number; rows: RowResult[]; fileErrors: string[] }

const TEXT: Record<Kind, { title: string; what: string; createWord: string; updateWord: string }> = {
  employees: { title: 'Bulk add / update employees', what: 'employees', createWord: 'new employees', updateWord: 'employees updated' },
  salaries: { title: 'Bulk salary update', what: 'salaries', createWord: 'new salary versions', updateWord: '' },
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

/** download an Excel template, fill it in, upload it: check first, then import (all or nothing) */
export function BulkDialog({ kind, onClose, onDone }: { kind: Kind; onClose: () => void; onDone: () => void }) {
  const t = TEXT[kind];
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

  const download = async (mode: 'data' | 'blank') => {
    setBusy('download'); setError('');
    try { await downloadFile(`/api/bulk/${kind}/template?mode=${mode}`, `nutex-${kind}.xlsx`); } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const check = async (f: { name: string; data: string }) => {
    setBusy('check'); setError(''); setRes(null);
    try { setRes(await api.post<Result>(`/api/bulk/${kind}/import`, { file: f.data, fileName: f.name, dryRun: true })); } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(''); setRes(null);
    if (!/\.xlsx$/i.test(f.name)) { setError('Please choose an Excel file saved as .xlsx (the downloaded template).'); return; }
    if (f.size > 4 * 1024 * 1024) { setError('The file is larger than 4 MB. Split it into smaller files.'); return; }
    try { const next = { name: f.name, data: await toBase64(f) }; setFile(next); await check(next); } catch (e) { fail(e); }
  };

  const importNow = async () => {
    if (!file) return;
    setBusy('import'); setError('');
    try {
      const r = await api.post<Result>(`/api/bulk/${kind}/import`, { file: file.data, fileName: file.name, dryRun: false });
      setRes(r);
      if (r.applied) { toast.push({ kind: 'ok', text: `Imported: ${r.created} created${t.updateWord ? `, ${r.updated} updated` : ''}` }); onDone(); onClose(); }
    } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const changes = (res?.created ?? 0) + (res?.updated ?? 0);
  const canImport = !!res && !res.fileErrors.length && res.errorCount === 0 && changes > 0 && !busy;
  const bad = res?.rows.filter((r) => r.action === 'error') ?? [];

  return (
    <Modal title={t.title} onClose={onClose}>
      <ol className="bulk-steps">
        <li>
          <b>1. Download the Excel file.</b> It already has today&apos;s data, so you edit it and upload it back.
          <span className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={!!busy} onClick={() => download('data')}><Icon name="download" size={15} /> Download current {t.what}</button>
            <button className="btn" disabled={!!busy} onClick={() => download('blank')}><Icon name="download" size={15} /> Blank template</button>
          </span>
          <p className="muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
            <span className="req-key req">Red</span> column titles are required, <span className="req-key opt">blue</span> are optional, <span className="req-key info">grey</span> are only for reading. The Instructions sheet explains the rest.
          </p>
        </li>
        <li>
          <b>2. Upload the filled file.</b> It is checked first; nothing is saved until you press Import.
          <span className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn primary" disabled={!!busy} onClick={() => input.current?.click()}>{file ? 'Choose another file' : 'Choose Excel file'}</button>
            {file && <span className="muted">{file.name}</span>}
            {busy === 'check' && <span className="muted">Checking…</span>}
          </span>
        </li>
      </ol>

      {error && <div className="notice bad" role="alert">{error}</div>}
      {res?.fileErrors.map((m) => <div key={m} className="notice bad" role="alert">{m}</div>)}

      {res && !res.fileErrors.length && (
        <div className="stack" style={{ gap: 10 }}>
          <p>
            <b>{res.total}</b> row{res.total === 1 ? '' : 's'} read: <Badge value={`${res.created} ${t.createWord}`} tone="ok" />{' '}
            {t.updateWord && <><Badge value={`${res.updated} ${t.updateWord}`} tone="info" />{' '}</>}
            <Badge value={`${res.unchanged} unchanged`} tone="neutral" />{' '}
            {res.errorCount > 0 && <Badge value={`${res.errorCount} with problems`} tone="bad" />}
          </p>
          {bad.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 260 }}>
              <table>
                <thead><tr><th>Row</th><th>Code</th><th>Problem</th></tr></thead>
                <tbody>{bad.map((r) => <tr key={r.row}><td className="num">{r.row}</td><td>{r.key}</td><td>{r.errors.map((e) => <div key={e}>{e}</div>)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {bad.length === 0 && changes > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table>
                <thead><tr><th>Row</th><th>Code</th><th>What will happen</th></tr></thead>
                <tbody>{res.rows.filter((r) => r.action === 'create' || r.action === 'update').slice(0, 200).map((r) => (
                  <tr key={r.row}><td className="num">{r.row}</td><td>{r.key}</td><td>{r.action === 'create' ? (kind === 'salaries' ? `New salary ${r.changes[0] ?? ''}` : 'New employee') : `Update: ${r.changes.join(', ')}`}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {res.errorCount > 0 && <p className="muted">Fix these rows in the Excel file and upload it again. Nothing was saved.</p>}
          {res.errorCount === 0 && changes === 0 && <p className="muted">Nothing to change: every row already matches what is saved.</p>}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" disabled={!canImport} onClick={importNow}>{busy === 'import' ? 'Importing…' : changes ? `Import ${changes} change${changes === 1 ? '' : 's'}` : 'Import'}</button>
      </div>
    </Modal>
  );
}
