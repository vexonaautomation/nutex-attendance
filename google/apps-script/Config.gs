/**
 * NUTEX Apps Script bundle: configuration + small helpers.
 * Business calculations live in the sheet formulas. This code only transports, locks, audits and schedules.
 */
var NUTEX = {
  SCHEMA_VERSION: '2.0.0',
  TABS: {
    CONFIG: 'SYSTEM_CONFIG', EVENTS: 'ATTENDANCE_EVENTS', DAILY: 'ATTENDANCE_DAILY', EXCEPTIONS: 'ATTENDANCE_EXCEPTIONS',
    LEAVE_BAL: 'LEAVE_BALANCES', LEAVE_TX: 'LEAVE_TRANSACTIONS', PAY_CTRL: 'PAYROLL_CONTROL', PAY_CALC: 'PAYROLL_CALC',
    SNAPSHOT: 'PAYROLL_SNAPSHOT', LOANS_SCHED: 'LOAN_SCHEDULE', AUDIT: 'AUDIT_LOG', NOTIFY: 'NOTIFICATIONS'
  },
  /** idempotency cache lifetime for the gateway (seconds) */
  IDEMPOTENCY_TTL_SEC: 6 * 60 * 60
};

function ss_() { return SpreadsheetApp.getActive(); }

function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('Missing tab ' + name);
  return s;
}

/** ISO local timestamp in the script time zone */
function nowLocal_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function cfg_(key) {
  var rows = sheet_(NUTEX.TABS.CONFIG).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) return rows[i][1];
  return null;
}

function newId_(prefix) { return prefix + '-' + Utilities.getUuid(); }

/** constant-time string compare for the gateway token */
function safeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  var r = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
