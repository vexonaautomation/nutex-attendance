/**
 * Payroll: lock a period. Copies PAYROLL_CALC to PAYROLL_SNAPSHOT as VALUES with row hashes, marks loan installments
 * deducted, then sets the period LOCKED. Idempotent and lock-protected. The maths stays in PAYROLL_CALC / STATUTORY_CALC.
 */
function lockPayrollPeriod(periodId, actor) {
  return withLock_(function () {
    var p = findRowByKey_(NUTEX.TABS.PAY_CTRL, periodId, 'period_id');
    if (!p) throw new Error('Unknown period ' + periodId);
    if (p.status === 'LOCKED') return { alreadyLocked: true };
    if (p.status !== 'APPROVED') throw new Error('Only an APPROVED period can be locked (status: ' + p.status + ')');
    if (p.ready_to_approve !== 'YES') throw new Error('Period has rows needing attention');
    var calc = readAll_(NUTEX.TABS.PAY_CALC).filter(function (r) { return r.period_id === periodId; });
    var existing = {};
    readAll_(NUTEX.TABS.SNAPSHOT).forEach(function (s) { existing[s.snapshot_id] = true; });
    var hashes = [];
    calc.forEach(function (c) {
      var clean = {};
      Object.keys(c).forEach(function (k) { if (k !== '_row') clean[k] = c[k]; });
      var rowHash = sha256Hex_(JSON.stringify(clean));
      hashes.push(rowHash);
      var id = 'SNAP-' + periodId + '-v' + p.version + '-' + c.employee_id;
      if (existing[id]) return;
      appendRow_(NUTEX.TABS.SNAPSHOT, {
        snapshot_id: id, period_id: periodId, period_version: p.version, employee_id: c.employee_id, paid_days: c.paid_days, lop_days: c.lop_days,
        gross_earnings: c.gross_earnings, pf_emp: c.pf_emp, esi_emp: c.esi_emp, pt: c.pt, lwf_emp: c.lwf_emp, tds: c.tds, loan_emi: c.loan_emi,
        advance_recovery: c.advance_recovery, other_deduction: c.other_deduction, reimbursement: c.reimbursement, total_deductions: c.total_deductions,
        net_pay: c.net_pay, employer_cost: c.employer_cost, calc_json: JSON.stringify(clean), row_hash: rowHash, locked_at: nowLocal_(), locked_by: actor || 'APPS_SCRIPT'
      });
    });
    if (p.run_type === 'REGULAR') {
      readAll_(NUTEX.TABS.LOANS_SCHED).forEach(function (l) {
        if (l.due_period_id === periodId && l.status === 'SCHEDULED') {
          updateCells_(NUTEX.TABS.LOANS_SCHED, l._row, { status: 'DEDUCTED', deducted_in_period_id: periodId, deducted_at: nowLocal_() });
        }
      });
    }
    updateCells_(NUTEX.TABS.PAY_CTRL, p._row, { status: 'LOCKED', locked_by: actor || 'APPS_SCRIPT', locked_at: nowLocal_(), snapshot_hash: sha256Hex_(JSON.stringify(hashes)) });
    audit_('PAYROLL_LOCKED', 'PAYROLL_PERIOD', periodId, { status: 'APPROVED' }, { status: 'LOCKED', rows: calc.length });
    return { locked: true, rows: calc.length };
  }, 60000);
}
