'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { Brand } from './Brand';
import { Icon } from './Icon';
import { Loading } from './ui';
import { visibleNav } from '@/lib/nav';
import { label } from '@/lib/format';

const THEME_KEY = 'nutex.theme';

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage may be blocked */ }
    const t = saved === 'light' || saved === 'dark' ? saved : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }, []);
  const toggle = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* per-viewer convenience only */ }
  };
  return { theme, toggle };
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { me, perms, loading, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const bare = path === '/login' || path === '/change-password';
  const mustChange = !!me?.mustChangePassword;

  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { if (!loading && !me && !bare) router.replace(`/login?next=${encodeURIComponent(path)}`); }, [loading, me, bare, path, router]);
  // a password chosen by the administrator must be replaced before anything else is used
  useEffect(() => { if (!loading && mustChange && path !== '/change-password') router.replace('/change-password'); }, [loading, mustChange, path, router]);

  if (bare) return <>{children}</>;
  if (loading || !me || mustChange) return <div className="content"><Loading rows={6} /></div>;

  const items = visibleNav(perms);
  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="side-brand"><Brand /><div><b>NUTEX</b><small>Smart Attendance</small></div></div>
        <nav className="nav">
          {items.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(`${n.href}/`) ? 'page' : undefined}><Icon name={n.icon} /> {n.label}</Link>
          ))}
        </nav>
        <span className="spacer" />
        <div className="muted" style={{ fontSize: '0.8rem', padding: '0 8px' }}>{me.name}<br />{label(me.role)}</div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <strong>{items.find((n) => path.startsWith(n.href))?.label ?? 'NUTEX'}</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title="Theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button className="btn sm" onClick={() => void logout()}><Icon name="logout" size={16} /> Sign out</button>
        </header>
        <main className="content" id="main">{children}</main>
      </div>
    </div>
  );
}
