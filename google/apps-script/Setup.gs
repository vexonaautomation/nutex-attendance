/** One-time installer + menu. Run installTriggers() once as the workbook owner. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncExceptions').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('monthlyAccrualTrigger').timeBased().onMonthDay(1).atHour(3).create();
  ScriptApp.newTrigger('drainNotifications').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(4).create();
  return 'Installed ' + ScriptApp.getProjectTriggers().length + ' triggers';
}

/**
 * Weekly full copy of the workbook. Uses Spreadsheet.copy (spreadsheets scope only, no broad Drive scope), so the copy lands
 * in the owner's My Drive; file it into the backup folder by hand or with scripts/backup-google-data.ts (service account).
 */
function weeklyBackup() {
  var name = 'NUTEX backup ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var copy = ss_().copy(name);
  audit_('BACKUP_CREATED', 'SPREADSHEET', copy.getId(), null, { name: name });
}

function healthSummary_() {
  var out = { errors: 0, metrics: {} };
  readAll_('DASHBOARD_DATA').forEach(function (r) {
    if (String(r.metric_key).indexOf('h_') === 0) {
      out.metrics[r.metric_key] = r.value;
      if (typeof r.value === 'string' && r.value.charAt(0) === '#') out.errors++;
    }
  });
  return out;
}

function verifyHealth() {
  var h = healthSummary_();
  var msg = h.errors ? h.errors + ' formula health metric(s) show errors.\n' + JSON.stringify(h.metrics) : 'All health metrics evaluate without errors.';
  SpreadsheetApp.getUi().alert('NUTEX health', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('NUTEX')
    .addItem('Verify health', 'verifyHealth')
    .addItem('Sync attendance exceptions', 'syncExceptions')
    .addItem('Install triggers (owner only)', 'installTriggers')
    .addToUi();
}
