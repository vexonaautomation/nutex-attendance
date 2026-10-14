'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { Brand } from '@/components/Brand';
import { Field, PasswordInput } from '@/components/ui';
import { passwordProblem } from '@/lib/password';

/** first sign-in with a password issued by the administrator: choose your own before using the app */
export default function ChangePasswordPage() {
  const router = useRouter();
  const { me, loading, refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loading && !me) router.replace('/login'); }, [loading, me, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next, me?.email ?? '') ?? (next !== again ? 'The two new passwords do not match' : next === current ? 'Choose a password different from the current one' : null);
    if (problem) return setError(problem);
    setBusy(true); setError('');
    try {
      await api.post('/api/auth/change-password', { current, next });
      await refresh();
      router.replace('/dashboard');
    } catch (err) {
      setError((err as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="login-card">
        <Brand size="lg" />
        <form onSubmit={submit} aria-label="Choose a new password">
          <h1 style={{ fontSize: '1.25rem', textAlign: 'center' }}>Choose your own password</h1>
          <p className="muted" style={{ textAlign: 'center' }}>{me?.mustChangePassword ? 'Your administrator gave you a temporary password. Set a new one to continue.' : 'Change your password.'}</p>
          <Field label="Current (temporary) password"><PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" label="Current password" /></Field>
          <Field label="New password" hint="At least 8 characters with letters and digits"><PasswordInput value={next} onChange={setNext} autoComplete="new-password" label="New password" minLength={8} /></Field>
          <Field label="Repeat new password"><PasswordInput value={again} onChange={setAgain} autoComplete="new-password" label="Repeat new password" minLength={8} /></Field>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
          <button type="button" className="btn" onClick={() => void logout()}>Sign out</button>
        </form>
      </div>
    </main>
  );
}
