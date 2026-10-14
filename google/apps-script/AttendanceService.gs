/**
 * Attendance: idempotent event append + nightly exception registry sync.
 * No attendance maths here: ATTENDANCE_DAILY is formulas.
 */
function appendAttendanceEvent_(p, requestId) {
  return withLock_(function () {
    var cache = CacheService.getScriptCache();
    var ck = 'idem:' + p.idempotency_key;
    var hit = cache.get(ck);
    if (hit) return { replayed: true, event_id: hit };
    var existing = findRowByKey_(NUTEX.TABS.EVENTS, p.idempotency_key, 'idempotency_key');
    if (existing) {
      cache.put(ck, existing.event_id, NUTEX.IDEMPOTENCY_TTL_SEC);
      return { replayed: true, event_id: existing.event_id };
    }
    var lat = Number(p.geo_lat), lng = Number(p.geo_lng);
    if (p.geo_lat !== undefined && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error('Invalid location');
    var id = newId_('EV');
    appendRow_(NUTEX.TABS.EVENTS, {
      event_id: id, employee_id: p.employee_id, event_datetime: p.event_datetime, event_datetime_utc: p.event_datetime_utc, event_type: p.event_type,
      capture_method: p.capture_method || 'WEB', device_id: p.device_id, geo_lat: p.geo_lat, geo_lng: p.geo_lng, geo_accuracy: p.geo_accuracy, geo_status: p.geo_status, geo_distance_m: p.geo_distance_m,
      idempotency_key: p.idempotency_key, company_id: p.company_id, created_at: nowLocal_(), created_by: 'APPS_SCRIPT', source: 'GATEWAY',
      request_id: requestId, status: 'ACTIVE'
    });
    cache.put(ck, id, NUTEX.IDEMPOTENCY_TTL_SEC);
    audit_('ATTENDANCE_EVENT_CREATED', 'ATTENDANCE_EVENT', id, null, { employee_id: p.employee_id, type: p.event_type }, '', requestId);
    return { replayed: false, event_id: id };
  });
}

/** open an exception for every newly flagged day; resolve exceptions that no longer flag */
function syncExceptions() {
  return withLock_(function () {
    var daily = readAll_(NUTEX.TABS.DAILY);
    var ex = readAll_(NUTEX.TABS.EXCEPTIONS);
    var known = {};
    ex.forEach(function (e) { if (e.status !== 'RESOLVED') known[e.attendance_key] = true; });
    var opened = 0, resolved = 0;
    daily.forEach(function (d) {
      if (!d.exception_flag || known[d.daily_key]) return;
      appendRow_(NUTEX.TABS.EXCEPTIONS, {
        exception_id: newId_('EXC'), attendance_key: d.daily_key, employee_id: d.employee_id, work_date: d.work_date, exception_type: d.exception_flag,
        detected_at: nowLocal_(), status: 'OPEN', created_at: nowLocal_(), created_by: 'APPS_SCRIPT', source: 'TRIGGER'
      });
      opened++;
    });
    ex.forEach(function (e) {
      if (e.status === 'OPEN' && !e.still_flagged) {
        updateCells_(NUTEX.TABS.EXCEPTIONS, e._row, { status: 'RESOLVED', resolved_at: nowLocal_(), resolved_by: 'SYSTEM', resolution_note: 'No longer flagged' });
        resolved++;
      }
    });
    audit_('ATTENDANCE_EXCEPTIONS_SYNC', 'ATTENDANCE_EXCEPTIONS', 'trigger', null, { opened: opened, resolved: resolved });
    return { opened: opened, resolved: resolved };
  });
}
