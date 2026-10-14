/** Drains QUEUED EMAIL notifications with MailApp (quota aware). SMS / WhatsApp adapters are handled by the Node API. */
function drainNotifications() {
  return withLock_(function () {
    var quota = MailApp.getRemainingDailyQuota();
    var sent = 0, failed = 0;
    readAll_(NUTEX.TABS.NOTIFY).forEach(function (n) {
      if (n.status !== 'QUEUED' || n.channel !== 'EMAIL' || sent >= quota) return;
      try {
        var to = lookupEmail_(n.recipient_employee_id);
        if (!to) throw new Error('recipient has no email');
        MailApp.sendEmail(to, String(n.subject || 'NUTEX notification'), 'You have a new notification in NUTEX: ' + n.template);
        updateCells_(NUTEX.TABS.NOTIFY, n._row, { status: 'SENT', sent_at: nowLocal_(), attempts: Number(n.attempts || 0) + 1 });
        sent++;
      } catch (e) {
        updateCells_(NUTEX.TABS.NOTIFY, n._row, {
          status: Number(n.attempts || 0) >= 4 ? 'FAILED' : 'QUEUED', attempts: Number(n.attempts || 0) + 1, last_error: String(e.message).slice(0, 200)
        });
        failed++;
      }
    });
    return { sent: sent, failed: failed };
  });
}

function lookupEmail_(employeeId) {
  var e = findRowByKey_('EMPLOYEES', employeeId, 'employee_id');
  return e ? e.email : null;
}
