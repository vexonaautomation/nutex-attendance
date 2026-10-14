/** Serialises every write path. Concurrent web-app calls and triggers queue on the script lock. */
function withLock_(fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 30000)) throw new Error('LOCK_TIMEOUT: another NUTEX write is in progress, retry');
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}
