'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { label, toneOf } from '@/lib/format';
import { Icon } from './Icon';

export function Badge({ value, tone }: { value: unknown; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }) {
  if (value === null || value === undefined || value === '') return <span className="muted">-</span>;
  return <span className={`badge ${tone ?? toneOf(value)}`}>{label(value)}</span>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="row">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <span className="spacer" />
      {actions}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ height: 22, width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', hint }: { title?: string; hint?: string }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: { message: string; requestId?: string } | Error | string; onRetry?: () => void }) {
  const msg = typeof error === 'string' ? error : error.message;
  const rid = typeof error === 'object' && 'requestId' in error ? (error as { requestId?: string }).requestId : undefined;
  return (
    <div className="state bad" role="alert">
      <strong>{msg}</strong>
      {rid && <span className="mono muted">request {rid}</span>}
      {onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Field({ label: l, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{l}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <span className="err" role="alert">{error}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, small }: { title: string; onClose: () => void; children: ReactNode; small?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${small ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, withReason }: {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> | void; onClose: () => void; withReason?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose} small>
      <p>{message}</p>
      {withReason && <div style={{ marginTop: 12 }}><Field label="Reason (required, audited)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field></div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || (withReason && reason.trim().length < 3)} onClick={async () => { setBusy(true); try { await onConfirm(reason); onClose(); } finally { setBusy(false); } }}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; kind: 'ok' | 'bad' | 'info'; text: string; detail?: string }
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((y) => y.id !== id)), t.kind === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`} role="status">{t.text}{t.detail && <small>{t.detail}</small>}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} className="tab" onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

/** password field with a show / hide toggle (keyboard and screen-reader friendly) */
export function PasswordInput({ value, onChange, autoComplete = 'current-password', label: l = 'Password', minLength, required = true, autoFocus }: {
  value: string; onChange: (v: string) => void; autoComplete?: string; label?: string; minLength?: number; required?: boolean; autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} aria-label={l} minLength={minLength} required={required}
        autoFocus={autoFocus} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ paddingRight: 48 }}
      />
      <button
        type="button" className="icon-btn" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} title={shown ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 2, top: 2, width: 36, height: 36, border: 0, background: 'transparent' }}
      >
        <Icon name={shown ? 'eyeoff' : 'eye'} />
      </button>
    </div>
  );
}
