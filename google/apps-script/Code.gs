/**
 * Optional web-app gateway. Deploy as "Execute as: Me", "Anyone with the link"; every call must carry the GATEWAY_TOKEN
 * script property. All writes go through LockService.
 *
 * POST body (JSON): { token, requestId, action, payload }
 *   action: appendEvent | runAccrual | lockPeriod | syncExceptions | health
 */
function doGet() {
  return json_({ ok: true, service: 'nutex-gateway', schema: NUTEX.SCHEMA_VERSION });
}

function doPost(e) {
  var requestId = 'unknown';
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    requestId = String(body.requestId || newId_('REQ'));
    var token = PropertiesService.getScriptProperties().getProperty('GATEWAY_TOKEN');
    if (!token || !safeEqual_(body.token, token)) return json_({ ok: false, error: 'UNAUTHORIZED', requestId: requestId });
    var p = body.payload || {};
    switch (body.action) {
      case 'appendEvent': return json_({ ok: true, requestId: requestId, result: appendAttendanceEvent_(p, requestId) });
      case 'runAccrual': return json_({ ok: true, requestId: requestId, result: runAccrual(p.asOfDate) });
      case 'lockPeriod': return json_({ ok: true, requestId: requestId, result: lockPayrollPeriod(p.periodId, p.actor) });
      case 'syncExceptions': return json_({ ok: true, requestId: requestId, result: syncExceptions() });
      case 'health': return json_({ ok: true, requestId: requestId, result: healthSummary_() });
      default: return json_({ ok: false, error: 'UNKNOWN_ACTION', requestId: requestId });
    }
  } catch (err) {
    console.error(requestId, err);
    return json_({ ok: false, error: String(err.message || err).slice(0, 200), requestId: requestId });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
