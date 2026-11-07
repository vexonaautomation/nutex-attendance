import { createHash } from 'node:crypto';
import { KeyedMutex } from '@nutex/sheet-connector';
import type { AppContext, Actor } from '../common/core';
import { toLocalWallClock } from '../common/core';

const REDACT = new Set(['password_hash', 'mfa_secret_ref', 'template_ref', 'template_hash', 'embedding', 'imageJpegBase64', 'password']);
const CELL_LIMIT = 45_000;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== '_row').map(([k, x]) => [k, REDACT.has(k) ? '[REDACTED]' : redact(x)]));
  }
  return v;
}

function ser(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = JSON.stringify(redact(v));
  return s.length > CELL_LIMIT ? s.slice(0, CELL_LIMIT) + '…[truncated]' : s;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Append-only audit trail with a SHA-256 hash chain (each entry commits to the previous entry hash). */
export class AuditService {
  private mutex = new KeyedMutex();
  private lastHash: string | null = null;
  constructor(private ctx: AppContext) {}

  async write(actor: Pick<Actor, 'user' | 'requestId' | 'ip' | 'source'> | null, e: AuditEntry): Promise<void> {
    await this.mutex.run('audit-chain', async () => {
      if (this.lastHash === null) {
        const rows = await this.ctx.repo.readAll('AUDIT_LOG');
        this.lastHash = rows.length ? String(rows[rows.length - 1].entry_hash ?? '') : 'GENESIS';
      }
      const audit_id = this.ctx.id('AUD');
      const timestamp = toLocalWallClock(this.ctx.now(), this.ctx.env.COMPANY_TIMEZONE);
      const rec = {
        audit_id, timestamp, actor_user_id: actor?.user.userId ?? 'SYSTEM', actor_role: actor?.user.role ?? 'SYSTEM', action: e.action, entity_type: e.entityType,
        entity_id: e.entityId, before_json: ser(e.before), after_json: ser(e.after), reason: e.reason ?? '', source: actor?.source ?? 'SYSTEM', request_id: actor?.requestId ?? '',
        ip_address: actor?.ip ?? '', prev_hash: this.lastHash,
      };
      const entry_hash = hashEntry(rec);
      try {
        // the hash chain is the integrity check, so no read-back: one Google call per audit entry instead of two
        await this.ctx.repo.append('AUDIT_LOG', { ...rec, entry_hash }, { verify: false });
        this.lastHash = entry_hash;
      } catch (err) {
        this.lastHash = null; // re-read the chain head next time
        throw err;
      }
    });
  }

  /** many entries in one go (bulk imports): the chain is computed in memory and written with a single call */
  async writeMany(actor: Pick<Actor, 'user' | 'requestId' | 'ip' | 'source'> | null, entries: AuditEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.mutex.run('audit-chain', async () => {
      if (this.lastHash === null) {
        const rows = await this.ctx.repo.readAll('AUDIT_LOG');
        this.lastHash = rows.length ? String(rows[rows.length - 1].entry_hash ?? '') : 'GENESIS';
      }
      let prev = this.lastHash;
      const timestamp = toLocalWallClock(this.ctx.now(), this.ctx.env.COMPANY_TIMEZONE);
      const recs = entries.map((e) => {
        const rec = {
          audit_id: this.ctx.id('AUD'), timestamp, actor_user_id: actor?.user.userId ?? 'SYSTEM', actor_role: actor?.user.role ?? 'SYSTEM', action: e.action, entity_type: e.entityType,
          entity_id: e.entityId, before_json: ser(e.before), after_json: ser(e.after), reason: e.reason ?? '', source: actor?.source ?? 'SYSTEM', request_id: actor?.requestId ?? '',
          ip_address: actor?.ip ?? '', prev_hash: prev,
        };
        const entry_hash = hashEntry(rec);
        prev = entry_hash;
        return { ...rec, entry_hash };
      });
      try {
        await this.ctx.repo.appendMany('AUDIT_LOG', recs, { verify: false });
        this.lastHash = prev;
      } catch (err) {
        this.lastHash = null;
        throw err;
      }
    });
  }
}

export function hashEntry(rec: Record<string, unknown>): string {
  const keys = ['audit_id', 'timestamp', 'actor_user_id', 'actor_role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'reason', 'source', 'request_id', 'ip_address', 'prev_hash'];
  return createHash('sha256').update(keys.map((k) => String(rec[k] ?? '')).join('\u001f')).digest('hex');
}

/** verify the whole chain; returns the first broken audit_id or null */
export function verifyChain(rows: Array<Record<string, unknown>>): { ok: boolean; brokenAt?: string; checked: number } {
  let prev = 'GENESIS';
  for (const r of rows) {
    if (String(r.prev_hash) !== prev || hashEntry(r) !== String(r.entry_hash)) return { ok: false, brokenAt: String(r.audit_id), checked: rows.length };
    prev = String(r.entry_hash);
  }
  return { ok: true, checked: rows.length };
}
