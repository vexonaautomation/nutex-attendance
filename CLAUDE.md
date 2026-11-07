# CLAUDE.md - NUTEX Attendance & Payroll

Guidance for Claude Code (and humans) working in this repository.

## Non-negotiable rules

1. **Google Sheets is the database and the calculation engine.** Do not add PostgreSQL, MySQL, MongoDB, SQLite, Prisma, Supabase or Firebase. Drive stores binaries only.
2. **Business calculations are sheet formulas.** Never re-implement attendance, leave, OT, LOP, payroll or statutory maths in TypeScript. Code may validate, resolve ids, batch, retry, authorise, orchestrate and audit. To change a calculation, change the formula in `packages/formula-specs/src/tabs-*.ts`.
3. **Raw attendance events are append-only.** Corrections are `ATTENDANCE_ADJUSTMENTS` rows. `SheetRepository.update` refuses append-only tabs and formula columns.
4. **Locked payroll periods are immutable.** LOCK writes `PAYROLL_SNAPSHOT` values; locked reports read the snapshot. Every write path checks `assertNotLocked`.
5. **Every important action writes `AUDIT_LOG`** (hash chained) with actor, request id, before and after.
6. **Attendance is location-verified** (`PUNCH_REQUIRES_LOCATION`): `selfPunch` validates the device fix (accuracy, freshness, geofence) and `writeEvent` stores `geo_lat / geo_lng / geo_accuracy / geo_distance_m`. `writeEvent` is the ONLY writer of `ATTENDANCE_EVENTS`; the only other entry is the audited `manualPunch` (reason required, never for yourself). Never add another route that appends to `ATTENDANCE_EVENTS`.
7. **Accounts**: the SUPER_ADMIN issues every login (username + password, hashed with scrypt, generated passwords shown once). Admin-set passwords are temporary (`must_change_password`, enforced server-side). Removing an employee = archive (never delete) and it disables their logins. Timestamps in the workbook are company-local wall clock: convert with `wallClockToDate`, never `Date.parse(x + 'Z')` against real time.
8. **No fake credentials or pretend integrations.** Secrets come from `.env` (never committed).
9. **Monthly attendance grid** (`apps/api/src/attendance/monthly.ts`): day codes and OT minutes are the sheet's own `ATTENDANCE_DAILY` results; the grid only lays them out and adds them up for display (no attendance rule). When a month is over it is frozen into its own tab ("Nov 2026", values only, like `PAYROLL_SNAPSHOT`) by an hourly job and by the "Save as tab" button; a saved month is never overwritten (409 `ALREADY_SAVED`). Opening a month as someone with company-wide access creates the missing employee x day rows up to today. These tabs are outside the 44-tab schema: `SheetsGateway.listSheets / addSheet / styleGridSheet` are optional methods.

## Layout

```
packages/formula-specs   schema DSL + every tab, column, formula, enum, default (SOURCE OF TRUTH)
packages/sheet-connector SheetsGateway (Google | emulator), SheetRepository, retry/backoff, mutex, cache
packages/report-engine   report definitions (selection / projection over sheet-calculated columns)
apps/api                 Fastify API; services per domain; auth + RBAC in auth/auth.ts
apps/web                 Next.js UI; generic schema-driven forms in components/ResourcePage.tsx
google/setup             create-workbook, seed, verify, structure builders (pure, unit-tested)
google/apps-script       optional LockService gateway + triggers
tests/                   attendance (location), leave, payroll, security (incl. user management), e2e
```

## Schema DSL cheat sheet (`packages/formula-specs/src/dsl.ts`)

- `inp(name, type)` input column, `fx(name, formula, type)` formula column, `aud()` audit columns.
- **Inputs first, formulas last** (enforced by `assertLayout`); the API writes only the input block.
- In formulas: `@col` = this row, `[TAB.col]` = column range, `$CFG(KEY)`, `$RULE(CODE, dateExpr)`, `$LK(...)`, `$LKD(..., default)`, `{FRANGE:TAB}` = the tab's formula block.
- Use only functions that exist in Google Sheets **and** HyperFormula (`scripts/verify-formulas.ts` keeps the allowlist).
- **Never use `|` in composite keys** (HyperFormula treats it as regex alternation in criteria). Keys are `emp:date`, `period:emp`, `emp:type:year`.
- Time-dependent formulas read `ATTENDANCE_AS_OF` (kept current by `syncAttendanceClock`), never `TODAY()`. A test that needs "now" sets it with `env.repo.update('SYSTEM_CONFIG','ATTENDANCE_AS_OF',{value: dateTimeToSerial(...)})`. `makeApi()` turns the location rule OFF for speed; pass `requireLocation: true` to test the product default.
- Dates cross the API as ISO strings and are stored as serial numbers (`sheet-connector/src/serial.ts`); `0` in a date / datetime formula column means "none" and reads back as `null`.
- Writes use `valueInputOption: RAW`, so user text such as `=IMPORTXML(...)` is stored literally. Zod schemas also reject text starting with `= + - @`.

## Adding a field or formula

1. Edit the tab in `packages/formula-specs/src`.
2. `npm run schema:generate && npm run docs:generate`
3. Add or adjust a test in `tests/` (formula behaviour is tested through `tests/helpers.ts` -> emulator).
4. `npm run verify:formulas && npm test`

## Testing notes

- Formula tests: `makeEnv()` from `tests/helpers.ts` builds a small emulator workbook with the demo seed. Use `bulkPunches` to add many events with one recalculation (each write recalculates the workbook).
- API tests: `makeApi()` from `tests/api-helpers.ts`; the clock is injectable (`api.clock.set(...)`). Sessions are long-lived in tests (`SESSION_TTL_MIN`).
- Test capacities are tiny; pass `big: { TAB: rows }` when a scenario needs more rows (a `CapacityError` / HTTP 507 means exactly that).
- Test passwords are synthetic values; the emulator refuses `NODE_ENV=production`.
- Local dev (`npm run dev:api` / `dev:mobile`) creates `admin` / `123` and disables lockout + rate limit (`NUTEX_DEV_ADMIN=0` to opt out). `loadEnv` throws in production if `LOGIN_MAX_ATTEMPTS` or `LOGIN_RATE_LIMIT_PER_MIN` is 0. Keep both guards.

## Security invariants to preserve

- Server-side RBAC (`ROLES` tab) + object-level scope (`ALL | BRANCH | TEAM | SELF`). A `SELF` / `TEAM` grant must never satisfy a company-wide config write (`authorizeCompanyWide`).
- No self-approval anywhere. Payroll approval is maker-checker (approver differs from submitter).
- Idempotency keys on punches and leave; parallel duplicates create one row.
- Errors never leak stack traces or payloads; 5xx carry only a request id and go to `ERROR_LOG`.

## Known limitations (be honest about them)

- Not exercised against real Google yet: run `npm run google:verify` after `google:create`.
- Single API instance assumed: mutex, session revocation and the audit hash-chain head are in-process. Multi-instance needs the Apps Script gateway or a shared lock / store.
- Statutory seed values are illustrative. TDS is manual or flat-rate.
- Browser location can be spoofed on a compromised or developer-mode phone; accuracy / freshness checks, geofences, audit and approvals reduce, not remove, the risk.
- A service account cannot store files in Drive (no quota): payslip PDFs and documents need a Shared Drive; Sheets features work without Drive.
