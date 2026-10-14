/** Append-only audit log with a SHA-256 hash chain (mirrors apps/api/src/audit/audit.ts). */
function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

function audit_(action, entityType, entityId, before, after, reason, requestId) {
  var rows = readAll_(NUTEX.TABS.AUDIT);
  var prev = rows.length ? String(rows[rows.length - 1].entry_hash) : 'GENESIS';
  var rec = {
    audit_id: newId_('AUD'), timestamp: nowLocal_(), actor_user_id: 'APPS_SCRIPT', actor_role: 'SYSTEM', action: action, entity_type: entityType, entity_id: entityId,
    before_json: before ? JSON.stringify(before) : '', after_json: after ? JSON.stringify(after) : '', reason: reason || '', source: 'APPS_SCRIPT',
    request_id: requestId || '', ip_address: '', prev_hash: prev
  };
  var keys = ['audit_id', 'timestamp', 'actor_user_id', 'actor_role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'reason', 'source', 'request_id', 'ip_address', 'prev_hash'];
  rec.entry_hash = sha256Hex_(keys.map(function (k) { return String(rec[k] === undefined ? '' : rec[k]); }).join('\u001f'));
  appendRow_(NUTEX.TABS.AUDIT, rec);
}
