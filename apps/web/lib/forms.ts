/** schema-driven form helpers used by the generic resource pages */
export interface FieldMeta {
  name: string; kind: 'input' | 'formula'; type: string; required: boolean; enum?: string; values?: string[]; ref?: string; note?: string; editable: boolean; hidden: boolean;
}

export const labelOf = (name: string): string => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function inputTypeFor(f: FieldMeta): 'select' | 'date' | 'datetime-local' | 'time' | 'number' | 'textarea' | 'text' {
  if (f.enum || f.type === 'yn') return 'select';
  switch (f.type) {
    case 'date': return 'date';
    case 'datetime': return 'datetime-local';
    case 'time': return 'time';
    case 'number': case 'money': case 'percent': return 'number';
    case 'json': return 'textarea';
    default: return 'text';
  }
}

export function optionsFor(f: FieldMeta): string[] {
  return f.type === 'yn' ? ['Y', 'N'] : f.values ?? [];
}

/** form state -> API payload: drop blanks, cast numbers, normalise date-times */
export function toPayload(fields: FieldMeta[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (raw === undefined || raw === '') continue;
    switch (inputTypeFor(f)) {
      case 'number': out[f.name] = Number(raw); break;
      case 'datetime-local': out[f.name] = raw.length === 16 ? `${raw}:00` : raw; break;
      case 'textarea': out[f.name] = raw; break;
      default: out[f.name] = raw;
    }
  }
  return out;
}

/** API row -> form state (for edit) */
export function toFormValues(fields: FieldMeta[], row: Record<string, unknown>): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of fields) {
    const x = row[f.name];
    if (x === null || x === undefined) { v[f.name] = ''; continue; }
    v[f.name] = inputTypeFor(f) === 'datetime-local' ? String(x).slice(0, 16) : String(x);
  }
  return v;
}

export function validate(fields: FieldMeta[], values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name] ?? '';
    if (f.required && v === '') errors[f.name] = 'Required';
    else if (v !== '' && inputTypeFor(f) === 'number' && !Number.isFinite(Number(v))) errors[f.name] = 'Must be a number';
    else if (v !== '' && /^[=+\-@]/.test(v) && inputTypeFor(f) === 'text' && !/^[-+]?\d+(\.\d+)?$/.test(v)) errors[f.name] = 'Cannot start with = + - @';
  }
  return errors;
}
