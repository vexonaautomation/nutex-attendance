# Operations runbook

## Monthly cycle

| When | Action | Where |
|---|---|---|
| Month start | attendance rows are scaffolded per period (payroll `PROCESSING` does it) | Payroll -> Start processing |
| Daily | resolve attendance exceptions (missing punch -> regularise or waive with a reason) | Attendance -> Exceptions |
| Month end | run leave accrual as of the month end (idempotent) | `POST /api/leave/accrual` |
| Cut-off | approve leave / OT / expenses / timesheets | Approvals |
| Payroll | `PROCESSING -> REVIEW` (HR) -> `APPROVED` (finance, different person) -> `LOCKED` | Payroll |
| After lock | generate payslips; export bank / PF / ESI; verify snapshot | Payroll |
| Year end | carry forward / lapse leave | `POST /api/leave/year-end` |

Corrections after lock: post **arrears** or an **off-cycle** run in a later period. Never unlock.

## Health checks

- Dashboard **Workbook health**: `h_errors_*` (formula errors per tab), duplicate keys, missing salary structure, missing shift, unresolved attendance, negative leave balances, approvals recorded after lock, ledger sign mismatches, payroll rows with missing attendance rows. All should be 0.
- `npm run google:verify` from a workstation: tabs, headers, formula drift, validations, protections, named ranges, capacity, Drive folders.
- `GET /api/audit/verify` (Audit page -> Verify chain): the hash chain of the audit log.
- `GET /api/payroll/periods/:id/verify-snapshot`: a locked period still matches its snapshot.

## Quotas and capacity

Google Sheets API (official): **300 read and 300 write requests per minute per project; 60 read and 60 write per minute per user per project**; 2 MB recommended payload; truncated exponential backoff on 429. The service account is one user, so plan for **60 reads / minute**.

The API mitigates this by reading only used rows (key column first), caching reads (`READ_CACHE_TTL_MS`, default 30 s; a write drops only the tabs it can change: the tab itself and the tabs whose formulas read it), batching writes, and retrying 429 / 5xx with exponential backoff and jitter. If you see `429` in logs or slow pages:

1. raise `READ_CACHE_TTL_MS` (30000 is fine for most sites);
2. lower page polling in the UI;
3. split load across more service accounts (each is a separate "user" for the per-user quota) - not built in, needs a small round-robin in `GoogleSheetsGateway`;
4. if you are near the project limits, move to a dedicated database (out of scope for this architecture).

Apps Script (official): 6 min per execution; trigger runtime 90 min/day (consumer) or 6 h/day (Workspace); 20 triggers per user per script; 100 / 1,500 email recipients per day.

**Cell budget.** Full capacity is about 6.9 M cells; Google's limit is 10 M. `CAPACITY_SCALE=0.25` is about 1.8 M. Dashboard `cap_*_pct` warns at 80 %. When `ATTENDANCE_EVENTS` approaches capacity:

1. lock the payroll period;
2. `npm run backup` (full copy + JSON of every tab);
3. copy the closed month's rows to a yearly archive workbook;
4. clear those rows from `ATTENDANCE_EVENTS` / `ATTENDANCE_DAILY` / `PAYROLL_INPUTS` / `PAYROLL_CALC` / `STATUTORY_CALC` (locked results remain in `PAYROLL_SNAPSHOT`);
5. re-run `npm run google:verify`.

Only clear rows of **locked** periods, and clear a whole month at once so `paid_days` sums stay consistent.

## Backup and restore

`npm run backup` makes (1) a Drive copy of the spreadsheet, (2) a JSON export per tab under `backups/<timestamp>/`, (3) Drive folder metadata (ids, names, sizes, MD5) so a restore can be verified. Store exports encrypted; they contain payroll and HR data. Restore = open the Drive copy, point `GOOGLE_SPREADSHEET_ID` at it, `npm run google:verify`. Binaries are in Drive already; Drive versioning / trash is your safety net.

## Incidents

| Symptom | Likely cause | Action |
|---|---|---|
| `507 CAPACITY` | a tab reached its formula capacity | archive locked months or raise `CAPACITY_SCALE` and rebuild |
| `423 PERIOD_LOCKED` | write into a locked period | post arrears / off-cycle instead |
| `NOT_READY` on approve | rows flagged `NO_SALARY_STRUCTURE`, `MISSING_ATTENDANCE_ROWS`, `UNRESOLVED_EXCEPTIONS`, `NEGATIVE_NET` | fix the input, waive with a reason, or add the salary row |
| `#REF!` / `#N/A` in a formula column | a range or lookup source was deleted or renamed | restore from backup; never delete rows or columns in a calculation tab |
| Audit chain broken | a row was edited or deleted in `AUDIT_LOG`, or two API instances wrote concurrently | treat as a security incident; compare with the backup |
| Snapshot mismatch | someone edited `PAYROLL_SNAPSHOT` | restore the tab from backup, investigate |
| Employees report `LOCATION_INACCURATE` / `GEOFENCE` | weak GPS indoors, or wrong branch coordinates / radius | check the branch latitude, longitude and radius; raise `LOCATION_MAX_ACCURACY_M`; use a manual punch or regularisation for the day |
| Someone cannot sign in | wrong password, locked (5 tries, 15 minutes), disabled login | Settings -> Logins: set a new password, enable, or wait for the lock to end |
| Sheet shows the workbook to a stranger | over-shared spreadsheet | remove access, review Drive sharing, rotate credentials |

## Access reviews (monthly)

Logins and roles (Settings -> Logins), sharing of the workbook and Drive folders, `ATTENDANCE_MANUAL_PUNCH` audit entries, `LOGIN_FAILED` / `LOGIN_BLOCKED_LOCKED` audit entries, super admin count, service-account key age (rotate at least yearly).
