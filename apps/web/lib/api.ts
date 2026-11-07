export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'x-requested-with': 'nutex', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && typeof window !== 'undefined' && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/me')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.requestId);
  }
  return data as T;
}

/** download a file the server builds (for example an Excel template) through the signed-in session */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'x-requested-with': 'nutex' } }); } catch { throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.'); }
  if (!res.ok) {
    let e: { error?: { code?: string; message?: string; requestId?: string } } | null = null;
    try { e = await res.json(); } catch { /* not JSON */ }
    throw new ApiError(res.status, e?.error?.code ?? 'ERROR', e?.error?.message ?? `Download failed (${res.status})`, e?.error?.requestId);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = objectUrl; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** stable random id for Idempotency-Key headers */
export const newKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const api = {
  get: <T = unknown>(url: string) => request<T>('GET', url),
  post: <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body ?? {}, headers),
  patch: <T = unknown>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T = unknown>(url: string, body: unknown) => request<T>('PUT', url, body),
  /** POST that is safe to retry: the same key can never create a second record */
  idem: <T = unknown>(url: string, body: unknown, key = newKey()) => request<T>('POST', url, body, { 'idempotency-key': key }),
};

export const qs = (o: Record<string, string | number | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
