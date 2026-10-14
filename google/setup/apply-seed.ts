import { ENUMS, SchemaIndex, readmeRows, colLetter } from '@nutex/formula-specs';
import { SheetRepository, toCell, type CellValue } from '@nutex/sheet-connector';
import { buildSeed } from './seed-data';

/** Order matters only for readability; formulas resolve lazily. */
const SEED_ORDER = [
  'SYSTEM_CONFIG', 'ROLES', 'DEPARTMENTS', 'DESIGNATIONS', 'LOCATIONS', 'SHIFT_MASTER', 'EMPLOYEES', 'USERS', 'HOLIDAYS', 'SALARY_COMPONENTS',
  'EMPLOYEE_SALARY', 'STATUTORY_RULES', 'LEAVE_TYPES', 'LEAVE_POLICIES', 'LEAVE_BALANCES', 'LEAVE_TRANSACTIONS', 'PAYROLL_CONTROL',
];

/** write LOOKUPS (one column per controlled list) and README (tab documentation) */
export async function writeReferenceTabs(repo: SheetRepository, idx: SchemaIndex): Promise<void> {
  const names = Object.keys(ENUMS);
  const height = Math.max(...Object.values(ENUMS).map((v) => v.length));
  const grid: CellValue[][] = [];
  for (let r = 0; r < height; r++) grid.push(names.map((n) => ENUMS[n][r] ?? null));
  await repo.gateway.writeRanges([{ range: `LOOKUPS!A2:${colLetter(names.length - 1)}${height + 1}`, values: grid }]);

  const readme = readmeRows(idx);
  const cols = idx.tab('README').columns;
  await repo.gateway.writeRanges([{
    range: `README!A2:${colLetter(cols.length - 1)}${readme.length + 1}`,
    values: readme.map((row) => cols.map((c) => toCell(c.type, row[c.name]))),
  }]);
}

export async function applySeed(repo: SheetRepository, idx: SchemaIndex, passwordHashes: Record<string, string> = {}, only?: string[]): Promise<Record<string, number>> {
  const seed = buildSeed(passwordHashes);
  const counts: Record<string, number> = {};
  for (const tab of SEED_ORDER) {
    if (only && !only.includes(tab)) continue;
    const rows = seed[tab] ?? [];
    if (!rows.length) continue;
    await repo.appendMany(tab, rows);
    counts[tab] = rows.length;
  }
  if (!only) await writeReferenceTabs(repo, idx);
  repo.invalidate();
  return counts;
}
