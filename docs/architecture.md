# Architecture

## Principles

1. **Sheets = data + calculation.** The workbook is the authoritative store and calculation layer. Formulas derive `ATTENDANCE_DAILY` from raw events, roster, holidays, leave, adjustments and shift policy, and `PAYROLL_CALC` from `PAYROLL_INPUTS`, salary, statutory rules and attendance.
2. **Code = transport, safety, workflow.** The API appends raw inputs, resolves ids, validates, authorises, batches, retries, locks, audits and moves workflow state (leave approval, payroll lifecycle). It reads formula results as-is.
3. **Drive = binaries.** Employee documents and payslip PDFs. Sheets keep ids, checksums and metadata.
4. **Location is evidence captured on the device.** The browser reads GPS; the API validates it (accuracy, freshness, geofence) and stores the coordinates on the attendance event. Distance to the branch is measured by the API; every attendance figure derived from the events is still a sheet formula.

## Components

```
Browser (Next.js)                      API (Fastify)                              Google
  pages, generic forms   -- /api -->   auth (scrypt, JWT cookie, lockout)
  GPS (Geolocation API)                RBAC + object scope (ROLES tab)            Sheets  data + formulas + protections
                                       services: attendance, leave,               Drive   files
                                       payroll, requests, reports, admin
                                       SheetRepository -> SheetsGateway --------> Sheets API v4 (batchGet / batchUpdate RAW)
                                       DriveStore ------------------------------> Drive API v3
                                       AuditService (hash chain)
```

`SheetsGateway` has two implementations: `GoogleSheetsGateway` (production) and `EmulatorGateway` (HyperFormula; tests and offline dev only, refused in production).

## Data flow: a check-in

1. `POST /api/attendance/punch` with an `Idempotency-Key` and the device fix `{ lat, lng, accuracy, capturedAt }`. Server time is converted to the branch time zone; the fix must be accurate (`LOCATION_MAX_ACCURACY_M`) and fresh (`LOCATION_MAX_AGE_SEC`); the branch geofence is checked; `writeEvent` appends one row to `ATTENDANCE_EVENTS` (input columns only, including `geo_lat`, `geo_lng`, `geo_accuracy`, `geo_distance_m`) through `appendIfAbsent`, and makes sure the day's `ATTENDANCE_DAILY` row exists. The sheet's `map_url` formula turns the coordinates into a Google Maps link.
2. The sheet recalculates: `is_dup`, `prev_in_dt`, `segment_minutes`, `work_date` on the event row, then `first_in`, `last_out`, `worked_minutes`, `status`, `day_credit`, `late_minutes`, `ot_*` on `ATTENDANCE_DAILY`.
3. The API reads the result back and returns it. Nothing was computed in TypeScript.

## Data flow: payroll

`OPEN -> PROCESSING (scaffold input rows) -> REVIEW (maker) -> APPROVED (checker, must be ready) -> LOCKED`.
LOCK appends `PAYROLL_SNAPSHOT` (values, row hashes, rules in force), marks loan installments `DEDUCTED`, and sets the period `LOCKED`. Locked periods are then reported from the snapshot, so a later edit to salary or a rule changes live formulas but not history (covered by `tests/e2e`).

## Guarantees and how they are enforced

| Guarantee | Mechanism |
|---|---|
| Raw punches never change | `SheetRepository.update` rejects append-only tabs; corrections are adjustment rows |
| Formula columns never written | inputs-first layout, repository refuses formula columns, `RAW` writes, protected ranges |
| No duplicate punches / leave | idempotency keys + `appendIfAbsent`, per-tab mutex |
| Locked periods immutable | `assertNotLocked` on punch, adjustment, leave, overtime, salary, rule paths; snapshot hash verification |
| Least privilege | `ROLES` matrix, scopes `ALL / BRANCH / TEAM / SELF`, no self-approval, maker-checker |
| Tamper evidence | `AUDIT_LOG` SHA-256 hash chain, `GET /api/audit/verify` |
| Quota safety | batch reads/writes, in-process read cache, exponential backoff with jitter on 429 / 5xx |
| Capacity awareness | formulas pre-filled to a capacity; `CapacityError` (HTTP 507); `cap_*` dashboard metrics |

## Partitioning strategy

`CAPACITY_SCALE` sizes each tab. For high event volume, keep the live workbook to a rolling window and archive **locked** months: export the closed period's `ATTENDANCE_EVENTS`, `ATTENDANCE_DAILY`, `PAYROLL_*` rows to a per-year archive workbook, then clear them from the live tabs. Locked results stay available from `PAYROLL_SNAPSHOT`. `PARTITION_STRATEGY` in `SYSTEM_CONFIG` records the policy; automated archiving is a runbook procedure, not built in (see the runbook). Google recommends considering a dedicated database near 10 million cells; the capacity metrics warn at 80 %.

## Extra tabs beyond the brief

`PAYROLL_SNAPSHOT` (immutable payroll values) and `EMPLOYEE_DOCUMENTS` (document metadata). Both are required by the brief's own rules (reproducible history; documents in Drive with metadata in Sheets).

## Deliberate limitations

- Single API instance: mutex, challenge nonces, session revocation and the audit chain head are in memory.
- The emulator is not Google. Differences are possible; `google:verify` and a parallel payroll run are the acceptance gate.
- No slab-based income-tax engine (manual or flat-rate TDS).
