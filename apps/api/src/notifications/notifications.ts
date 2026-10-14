import type { Actor, AppContext } from '../common/core';
import { auditCols } from '../common/core';

export interface Notice {
  recipientEmployeeId: string;
  template: string;
  subject: string;
  payload?: Record<string, unknown>;
  channel?: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'INAPP';
}

/**
 * Queue a notification in the NOTIFICATIONS outbox. In-app rows are read by the UI immediately; EMAIL rows are drained by the
 * Apps Script trigger (google/apps-script/NotificationService.gs) and SMS / WhatsApp rows by an adapter you plug in.
 * Failing to notify must never fail the business action, so errors are swallowed and reported to ERROR_LOG.
 */
export async function notify(ctx: AppContext, actor: Actor, n: Notice): Promise<void> {
  if (!n.recipientEmployeeId) return;
  try {
    await ctx.repo.append('NOTIFICATIONS', {
      notification_id: ctx.id('NTF'), recipient_employee_id: n.recipientEmployeeId, channel: n.channel ?? 'INAPP', template: n.template, subject: n.subject,
      payload_json: n.payload ?? {}, attempts: 0, ...auditCols(ctx, actor, 'QUEUED'),
    });
  } catch (e) {
    await ctx.repo.append('ERROR_LOG', { error_id: ctx.id('ERR'), severity: 'WARN', module: 'notifications', message: `notify failed: ${(e as Error).message}`.slice(0, 300), request_id: actor.requestId }).catch(() => undefined);
  }
}
