'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui';

export interface FetchState<T> { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void; setData: (d: T) => void }

/** GET with loading / error state. Pass null to skip (e.g. until a parameter is chosen). */
export function useFetch<T>(url: string | null): FetchState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!url);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!url) { setData(undefined); setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true);
    api.get<T>(url).then((d) => { if (n === seq.current) { setData(d); setError(undefined); } })
      .catch((e: ApiError) => { if (n === seq.current) setError(e); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [url, tick]);

  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}

/** run an action with a busy flag and toast feedback */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast.push({ kind: 'ok', text: ok });
      return r;
    } catch (e) {
      const err = e as ApiError;
      toast.push({ kind: 'bad', text: err.message, detail: err.requestId ? `request ${err.requestId}` : undefined });
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}
