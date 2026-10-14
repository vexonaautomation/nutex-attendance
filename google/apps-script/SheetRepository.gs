/**
 * Header-driven, batched sheet access. Reads and writes whole ranges (never cell-by-cell).
 * Writes only touch INPUT columns (everything left of the first formula column); formula columns are never written.
 */
function headers_(tab) {
  var s = sheet_(tab);
  return s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String);
}

/** index of the first formula column, detected from row 2 (inputs come first, formulas last) */
function firstFormulaCol_(tab) {
  var s = sheet_(tab);
  var f = s.getRange(2, 1, 1, s.getLastColumn()).getFormulas()[0];
  for (var i = 0; i < f.length; i++) if (f[i]) return i;
  return f.length;
}

function readAll_(tab) {
  var s = sheet_(tab);
  var h = headers_(tab);
  var lastRow = s.getLastRow();
  if (lastRow < 2) return [];
  var v = s.getRange(2, 1, lastRow - 1, h.length).getValues();
  var out = [];
  for (var r = 0; r < v.length; r++) {
    if (v[r][0] === '' || v[r][0] === null) continue;
    var o = { _row: r + 2 };
    for (var c = 0; c < h.length; c++) o[h[c]] = v[r][c];
    out.push(o);
  }
  return out;
}

/** next free row = last non-empty key cell + 1 (pre-filled formulas below do not count) */
function nextRow_(tab) {
  var s = sheet_(tab);
  var keys = s.getRange(2, 1, Math.max(s.getMaxRows() - 1, 1), 1).getValues();
  var last = 0;
  for (var i = 0; i < keys.length; i++) if (keys[i][0] !== '' && keys[i][0] !== null) last = i + 1;
  return last + 2;
}

/** append an object; strings that could be read as formulas get a leading apostrophe (formula-injection guard) */
function appendRow_(tab, obj) {
  var h = headers_(tab);
  var n = firstFormulaCol_(tab);
  var row = nextRow_(tab);
  var s = sheet_(tab);
  if (row > s.getMaxRows()) throw new Error(tab + ' is at capacity; extend capacity or archive closed periods');
  var vals = [];
  for (var c = 0; c < n; c++) {
    var v = obj[h[c]];
    if (typeof v === 'string' && /^[=+\-@]/.test(v) && isNaN(Number(v))) v = "'" + v;
    vals.push(v === undefined ? '' : v);
  }
  s.getRange(row, 1, 1, n).setValues([vals]);
  return row;
}

function updateCells_(tab, row, patch) {
  var h = headers_(tab);
  var n = firstFormulaCol_(tab);
  var s = sheet_(tab);
  for (var k in patch) {
    var i = h.indexOf(k);
    if (i < 0) throw new Error('Unknown column ' + k);
    if (i >= n) throw new Error(k + ' is a formula column');
    s.getRange(row, i + 1).setValue(patch[k]);
  }
}

function findRowByKey_(tab, key, keyCol) {
  var rows = readAll_(tab);
  var col = keyCol || headers_(tab)[0];
  for (var i = 0; i < rows.length; i++) if (String(rows[i][col]) === String(key)) return rows[i];
  return null;
}
