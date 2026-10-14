'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { can as canFn, type Perm } from '@/lib/nav';

export interface Me { userId: string; employeeId: string; email: string; role: string; companyId: string; locationScope: string[]; name: string; mustChangePassword?: boolean }

interface AuthState {
  me: Me | null; perms: Perm[]; loading: boolean; can: (resource: string, action?: 'read' | 'write' | 'approve' | 'export') => boolean; refresh: () => Promise<void>; logout: () => Promise<void>;
}
const Ctx = createContext<AuthState>({ me: null, perms: [], loading: true, can: () => false, refresh: async () => undefined, logout: async () => undefined });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [perms, setPerms] = useState<Perm[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: Me; permissions: Array<Omit<Perm, never>> }>('/api/auth/me');
      setMe(r.user);
      setPerms(r.permissions as Perm[]);
    } catch {
      setMe(null);
      setPerms([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } finally { setMe(null); setPerms([]); window.location.href = '/login'; }
  }, []);

  const value = useMemo<AuthState>(() => ({ me, perms, loading, refresh, logout, can: (r, a = 'read') => canFn(perms, r, a) }), [me, perms, loading, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
