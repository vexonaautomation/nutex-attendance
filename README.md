# NUTEX Attendance & Payroll

> **This is NUTEX Attendance: an independent copy of the VEXONA attendance app.** It shares nothing with VEXONA: its own GitHub repository, its own Google Cloud project, service account, key and spreadsheet, its own session cookie (`nutex_session`), request header and theme key, and its own `.env`. Do not point it at the VEXONA sheet or key, and do not copy VEXONA secrets here. Start from `.env.example` and `SETUP_GOOGLE.md` with a **new** Google project.


Attendance with **location check-in / check-out**, leave, overtime, payroll and statutory calculations for **NUTEX · Smart Attendance**.

**Google Sheets is the database and the calculation engine.** There is no SQL database. Every attendance, leave, overtime, payroll and statutory figure is a Google Sheets formula in the workbook *NUTEX Attendance & Payroll DB*. Google Drive holds binaries only (employee documents, payslip PDFs). The Node API validates, authorises, batches, retries, locks and audits; the Next.js web app is the UI.

```
Web / phone browser (Next.js)  ->  API (Fastify, TypeScript)  ->  Google Sheets (data + formulas)
                                                              ->  Google Drive (binaries, optional)
```

## How attendance works

1. The employee opens the site on their phone or PC and taps **Check in**. The browser reads the device location (GPS) and sends latitude, longitude and accuracy with the punch.
2. The API checks the reading (accurate enough, fresh, inside the branch geofence if the branch requires it) and appends one row to `ATTENDANCE_EVENTS` **with the coordinates**, the distance from the branch and a Google Maps link (`map_url`, a formula column).
3. **Check out** works the same way and stores its own coordinates.
4. The sheet formulas derive the day (`ATTENDANCE_DAILY`): present, half day, late, overtime, missing punch.

Rules live in *Settings -> System*: `PUNCH_REQUIRES_LOCATION`, `LOCATION_MAX_ACCURACY_M`, `LOCATION_MAX_AGE_SEC`; each branch has latitude, longitude, radius and `geofence_required`. A missed punch is fixed by an approved regularisation, or by an administrator's audited manual punch.

## The administrator controls everything

The `SUPER_ADMIN` role holds every permission. In the app they can add, edit, remove (archive, with restore) employees and every master record; **create a username and password for each person** (typed or generated, shown once, with an optional "choose your own password at first sign-in"); reset passwords; disable or re-enable logins; change roles and branch access; edit branches and their coordinates; add manual punches; change settings; run payroll. Nothing is ever hard-deleted, so payroll and audit history stay reproducible.

## Quick start (no Google account needed)

```bash
npm install
npm run setup          # creates .env with a generated session secret, generates schema artefacts
npm run dev:api        # emulator backend: same formulas, evaluated locally; demo logins in .local/seed-credentials.txt
npm run dev:web        # http://localhost:3000
npm run dev:mobile     # phone on the same Wi-Fi: prints an https:// address so the phone can share its location
```

**Local test login:** with the emulator backend the API creates the login `admin` / `admin` (super admin) and switches sign-in lockout and rate limit **off**, so testing is friction-free. Set `NUTEX_DEV_ADMIN=0` to turn that off. Neither can exist in production: the emulator is refused there, and the API refuses to start in production with lockout or the rate limit disabled.

The **emulator** loads the exact grid the Google setup script creates and evaluates the same formulas with HyperFormula. It exists for tests and offline development and is refused when `NODE_ENV=production`.

## Going live on Google

Follow the step-by-step guide in **[SETUP_GOOGLE.md](SETUP_GOOGLE.md)** (Hinglish). In short:

```bash
npm run google:create   # fills your blank, shared spreadsheet: 44 tabs, formulas, validations, protections
npm run google:init     # first administrator login + your first branch (no demo data)
npm run google:verify   # tabs, headers, formulas, validations, protections, config, formula health
npm run start:api       # then, in another terminal: npm run build && npm run start:web
```

Browsers only share location on **HTTPS**, so the live site needs a TLS address ([docs/deployment.md](docs/deployment.md)).

## What is in the box

| Area | Where |
|---|---|
| Workbook schema, formulas, validations, protections (single source of truth) | `packages/formula-specs` -> `google/sheet-schema/*.json` |
| Sheets / Drive connectors, retry + backoff, batching, emulator | `packages/sheet-connector`, `packages/drive-connector` |
| API: auth, RBAC + object-level scope, attendance + location, leave, payroll, reports, audit, user management | `apps/api` |
| Web app (3D glass UI, dark / light theme, animated login) | `apps/web` |
| Apps Script (LockService gateway, maintenance triggers), optional | `google/apps-script` |
| Setup / init / verify / backup scripts | `google/setup`, `scripts` |
| Docs (schema and formula docs are generated from the code) | `docs/` |

## Commands

| Command | Purpose |
|---|---|
| `npm test` | all unit, formula, API, security and end-to-end tests |
| `npm run verify:formulas` | formula health: parse, function allowlist, zero error cells |
| `npm run verify:headers` | static schema checks and drift check against `google/sheet-schema` |
| `npm run typecheck` / `npm run lint` / `npm run build` | quality gates |
| `npm run check` | everything above, in order |
| `npm run backup` | spreadsheet copy + JSON export of every tab + Drive metadata |

## Read this before production

- **Not yet run against a real Google account.** Everything is verified against the local formula engine. Run `npm run google:verify` and a parallel-run payroll against your current process before relying on it.
- **Location is evidence, not proof.** The browser location can be spoofed by "fake GPS" tools on a rooted or developer-mode phone. Accuracy and freshness checks, branch geofences, the audit log and manager approvals reduce the risk; they do not eliminate it.
- **Statutory rule values are illustrative.** PF, ESI, PT, LWF, gratuity and OT numbers in the seed are placeholders. Confirm each against current law and your state notifications and add correctly dated versions.
- **TDS** is either a manual amount from finance or an optional flat-rate rule. A slab / regime engine is not included.
- **Google Sheets quotas** (60 reads / minute / user) bound throughput. See [docs/operations-runbook.md](docs/operations-runbook.md) for capacity planning and the archive strategy.
- **Drive** needs a Shared Drive for payslip PDFs and documents (a service account has no storage quota). Everything else works with Sheets alone.
- **Licence note.** The local emulator uses HyperFormula (GPL-3.0 / commercial). It is used for tests and offline development only; if you distribute this software in a closed-source product, obtain a commercial licence or remove the emulator.

See also: [docs/architecture.md](docs/architecture.md) · [docs/deployment.md](docs/deployment.md) · [docs/operations-runbook.md](docs/operations-runbook.md) · [docs/google-sheets-schema.md](docs/google-sheets-schema.md) · [docs/payroll-formulas.md](docs/payroll-formulas.md)
