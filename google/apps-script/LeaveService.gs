/** Leave: post the formula-calculated accrual_pending to the ledger. Idempotent per (balance, target). */
function runAccrual(asOfIso) {
  return withLock_(function () {
    if (asOfIso) {
      var cfg = findRowByKey_(NUTEX.TABS.CONFIG, 'ACCRUAL_AS_OF_DATE', 'key');
      var serial = Math.round((Date.parse(asOfIso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
      updateCells_(NUTEX.TABS.CONFIG, cfg._row, { value: serial });
      SpreadsheetApp.flush();
    }
    var posted = 0;
    var seen = {};
    readAll_(NUTEX.TABS.LEAVE_TX).forEach(function (t) { seen[t.idempotency_key] = true; });
    readAll_(NUTEX.TABS.LEAVE_BAL).forEach(function (b) {
      if (!(Number(b.accrual_pending) > 0)) return;
      var key = 'accrual:' + b.balance_key + ':' + b.accrual_target;
      if (seen[key]) return;
      appendRow_(NUTEX.TABS.LEAVE_TX, {
        txn_id: newId_('LTX'), employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: b.leave_year, txn_type: 'ACCRUAL', txn_date: asOfIso || '',
        days: b.accrual_pending, reference_id: 'ACCRUAL', idempotency_key: key, remarks: 'Monthly accrual (trigger)', created_at: nowLocal_(),
        created_by: 'APPS_SCRIPT', source: 'TRIGGER', status: 'ACTIVE'
      });
      posted++;
    });
    audit_('LEAVE_ACCRUAL_RUN', 'LEAVE_TRANSACTIONS', asOfIso || 'trigger', null, { posted: posted });
    return { posted: posted };
  });
}

function monthlyAccrualTrigger() {
  var d = new Date();
  var last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return runAccrual(Utilities.formatDate(last, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
}
