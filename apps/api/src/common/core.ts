import { randomUUID } from 'node:crypto';
import type { SchemaIndex } from '@nutex/formula-specs';
import { loadConfig, type ConfigMap, type Row, type SheetRepository } from '@nutex/sheet-connector';
import type { DriveStore } from '@nutex/drive-connector';
import type { SessionUser } from '@nutex/types';
import { AuditService } from '../audit/audit';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
export const badRequest = (m: string, code = 'BAD_REQUEST') => new HttpError(400, code, m);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, 'UNAUTHENTICATED', m);
export const forbidden = (m = 'You do not have access to this resource') => new HttpError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found') => new HttpError(404, 'NOT_FOUND', m);
export const conflict = (m: string, code = 'CONFLICT') => new HttpError(409, code, m);

export interface Env {
  NODE_ENV: string;
  SESSION_SECRET: string;
  SESSION_TTL_MIN: number;
  COOKIE_SECURE: boolean;
  CORS_ORIGIN: string;
  /** failed sign-ins before an account is locked. 0 = lockout disabled (refused in production) */
  LOGIN_MAX_ATTEMPTS: number;
  LOGIN_LOCK_MINUTES: number;
  /** sign-in attempts per minute per IP. 0 = throttle disabled (refused in production) */
  LOGIN_RATE_LIMIT_PER_MIN: number;
  COMPANY_TIMEZONE: string;
}

export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  const prod = src.NODE_ENV === 'production';
  const need = (k: string) => {
    const v = src[k];
    if (!v) {
      if (prod) throw new Error(`${k} must be set in production`);
      return undefined;
    }
    return v;
  };
  const secret = need('SESSION_SECRET') ?? 'dev-only-session-secret-change-me-0123456789abcdef';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const maxAttempts = Number(src.LOGIN_MAX_ATTEMPTS ?? 5);
  const rateLimit = Number(src.LOGIN_RATE_LIMIT_PER_MIN ?? 20);
  if (![maxAttempts, rateLimit].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('LOGIN_MAX_ATTEMPTS and LOGIN_RATE_LIMIT_PER_MIN must be numbers >= 0');
  // brute-force protection may be switched off for local testing only
  if (prod && (maxAttempts === 0 || rateLimit === 0)) throw new Error('Account lockout and the sign-in rate limit cannot be disabled in production (LOGIN_MAX_ATTEMPTS / LOGIN_RATE_LIMIT_PER_MIN must be > 0)');
  return {
    NODE_ENV: src.NODE_ENV ?? 'development', SESSION_SECRET: secret, SESSION_TTL_MIN: Number(src.SESSION_TTL_MIN ?? 480),
    COOKIE_SECURE: (src.COOKIE_SECURE ?? (prod ? 'true' : 'false')) === 'true', CORS_ORIGIN: src.CORS_ORIGIN ?? 'http://localhost:3000',
    LOGIN_MAX_ATTEMPTS: maxAttempts, LOGIN_LOCK_MINUTES: Number(src.LOGIN_LOCK_MINUTES ?? 15), LOGIN_RATE_LIMIT_PER_MIN: rateLimit,
    COMPANY_TIMEZONE: src.COMPANY_TIMEZONE ?? 'Asia/Kolkata',
  };
}

export interface AppContext {
  repo: SheetRepository;
  idx: SchemaIndex;
  drive: DriveStore;
  env: Env;
  audit: AuditService;
  now(): Date;
  /** UUID-based stable id, e.g. EV-3f2a... */
  id(prefix: string): string;
  systemConfig(): Promise<ConfigMap>;
}

export function createContext(p: { repo: SheetRepository; idx: SchemaIndex; drive: DriveStore; env: Env; now?: () => Date }): AppContext {
  const now = p.now ?? (() => new Date());
  const ctx: AppContext = {
    repo: p.repo, idx: p.idx, drive: p.drive, env: p.env, now,
    audit: undefined as unknown as AuditService,
    id: (prefix) => `${prefix}-${randomUUID()}`,
    systemConfig: () => loadConfig(p.repo, 'SYSTEM_CONFIG'),
  };
  ctx.audit = new AuditService(ctx);
  return ctx;
}

export interface Actor { user: SessionUser; requestId: string; ip?: string; source: string }

/** company-local wall clock parts for an IANA timezone -> 'YYYY-MM-DDTHH:mm:ss' */
export function toLocalWallClock(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}

/**
 * The inverse of toLocalWallClock: the instant a company-local 'YYYY-MM-DDTHH:mm:ss' stands for. Timestamps in the workbook (password
 * changes, lock-outs, punches) are wall-clock values; comparing them with real time needs this, not a naive `Date.parse(local + 'Z')`.
 */
export function wallClockToDate(local: string, timeZone: string): Date {
  const guess = Date.parse(`${local}Z`);
  const shown = Date.parse(`${toLocalWallClock(new Date(guess), timeZone)}Z`);
  return new Date(guess - (shown - guess));
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function auditCols(ctx: AppContext, actor: Actor, status = 'ACTIVE') {
  const now = toLocalWallClock(ctx.now(), ctx.env.COMPANY_TIMEZONE);
  return {
    company_id: actor.user.companyId, created_at: now, created_by: actor.user.userId, updated_at: now, updated_by: actor.user.userId,
    source: actor.source, request_id: actor.requestId, status,
  };
}

export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export type { Row };
