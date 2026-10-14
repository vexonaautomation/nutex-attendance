'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { Brand } from '@/components/Brand';
import { Icon } from '@/components/Icon';
import { Field, PasswordInput } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.post<{ user: { mustChangePassword?: boolean } }>('/api/auth/login', { email, password });
      await refresh();
      router.replace(r.user.mustChangePassword ? '/change-password' : next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.status === 423 ? 'Too many attempts. This account is locked for a few minutes.' : e2.status === 401 ? 'Invalid login ID or password.' : e2.message);
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="login-wrap">
        <section className="login-hero" aria-label="About NUTEX Attendance">
          <div className="scene" aria-hidden="true">
            <span className="orbit" /><span className="orbit o2" />
            <span className="float a" /><span className="float b" /><span className="float c" />
            <div className="cube">
              <div className="face f1"><Icon name="pin" /></div>
              <div className="face f2"><Icon name="clock" /></div>
              <div className="face f3"><Icon name="check" /></div>
              <div className="face f4"><Icon name="wallet" /></div>
              <div className="face f5"><Icon name="users" /></div>
              <div className="face f6"><Icon name="shield" /></div>
            </div>
          </div>
          <h1>Attendance that <em>knows where</em> you are.</h1>
          <p>Check in and out from your phone with your live location, see your month at a glance, and get paid on time. Every punch lands in the company sheet with coordinates.</p>
          <div className="chips"><span className="chip">Live location</span><span className="chip">Leave</span><span className="chip">Payroll</span><span className="chip">Audit trail</span></div>
        </section>
        <div className="login-card">
          <Brand size="lg" />
          <h2 style={{ textAlign: 'center', fontSize: '1.25rem' }}>Sign in to NUTEX</h2>
          <form onSubmit={submit} aria-label="Sign in">
            <Field label="Username"><input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Password"><PasswordInput value={password} onChange={setPassword} /></Field>
            {error && <div className="notice bad" role="alert">{error}</div>}
            <button className="btn primary big" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p className="muted" style={{ fontSize: '0.8rem', textAlign: 'center' }}>Forgot your password? Ask your administrator or HR.</p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
