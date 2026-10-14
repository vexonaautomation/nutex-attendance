# Deployment

## Topology

```
Browser --HTTPS--> Next.js (apps/web)  --/api proxy-->  Fastify API (apps/api)  -->  Google Sheets + Drive
```

The web app proxies `/api/*` to the API (`next.config.ts` rewrites), so the browser only talks to one HTTPS origin: the session cookie is first-party (`HttpOnly`, `SameSite=Strict`, `Secure`) and the API and Google credentials are never exposed. Browsers share location only with HTTPS pages (or `localhost`), so the public address must be HTTPS.

## Environment

Copy `.env.example` (`npm run setup` does it); the API reads `.env` from the repository root, and real environment variables override it. `npm run verify:env -- --production` checks it. Production must have:

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | disables the emulator, forces secrets to be set |
| `NUTEX_BACKEND=google` | |
| `SESSION_SECRET` | >= 32 random chars |
| `COOKIE_SECURE=true`, `CORS_ORIGIN=https://your-host` | |
| Google credentials + `GOOGLE_SPREADSHEET_ID`, `CAPACITY_SCALE` (and `DRIVE_*` ids if you use Drive) | see SETUP_GOOGLE.md |
| `API_URL` (web) | private URL of the API, for the Next.js proxy |

Secrets go in a secret manager (or the platform's encrypted env), never in git. Restrict the service-account key file to the API host.

## Build and run

```bash
npm ci
npm run check            # schema, docs, types, lint, tests, formulas, build
# API
NODE_ENV=production npm run start:api
# Web (after `npm run build`)
API_URL=http://localhost:4000 npm run start:web
```

Run **one API instance** (see limitations in the architecture doc) behind a TLS-terminating proxy (Caddy, nginx, a cloud load balancer). Set `trustProxy` headers correctly so login throttling sees real client IPs. A process supervisor (systemd, Docker restart policy, Cloud Run min 1 / max 1) keeps it alive.

## Render (two services, HTTPS included)

`render.yaml` describes both services. Render -> New -> Blueprint -> pick the repository, or create two Web Services by hand with these values.

**Service 1: API** (`nutex-api`, Node, 1 instance, health check `/api/health`)
Build `npm ci --include=dev` (the API runs through `tsx`, a dev dependency) · Start `npm run start:api`

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NUTEX_BACKEND` | `google` |
| `SESSION_SECRET` | long random text (Render can generate it) |
| `COOKIE_SECURE` | `true` |
| `CORS_ORIGIN` | `https://<your website service>.onrender.com` (or your own domain) |
| `COMPANY_TIMEZONE` | `Asia/Kolkata` |
| `GOOGLE_SPREADSHEET_ID` | the id from the sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the service-account key file, base64 encoded (secret) |
| `CAPACITY_SCALE` | `0.25` (must equal the value the workbook was built with) |
| `READ_CACHE_TTL_MS` | `30000` |

Base64 of the key file on Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secrets\attendance-sa.json"))` (on Linux or macOS: `base64 -w0 key.json`). Paste the single line into Render as a secret. Never commit the key.

**Service 2: Website** (`nutex-web`, Node)
Build `npm ci --include=dev && npm run build` · Start `npm run start:web` (listens on Render's `PORT`)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `API_URL` | `https://<your api service>.onrender.com` (read at BUILD time: change it, then redeploy) |

Use a paid instance (Starter). Free instances sleep after 15 minutes, so the first check-in of the day would wait about a minute. Keep the API at one instance.

## Docker + automatic HTTPS (simplest production setup)

`docker-compose.yml` runs the API, the web app and Caddy (free Let's Encrypt certificate) on any small Linux server with a domain pointing at it:

```bash
# .env: NODE_ENV=production, NUTEX_BACKEND=google, COOKIE_SECURE=true, CORS_ORIGIN=https://attendance.example.com, Google ids,
#       GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/run/secrets/nutex-sa.json   (key file placed in ./secrets/)
DOMAIN=attendance.example.com docker compose up -d --build
```

Keep a single API container. Update with `git pull && docker compose up -d --build`.

## Checklist before go-live

1. `npm run google:verify` -> 0 failed, warnings understood.
2. Statutory rules reviewed and effective-dated for your jurisdiction; PT / LWF for your state.
3. Workbook initialised with `npm run google:init` (no demo users); real logins created in the app; super admin count minimised.
4. Every branch has its coordinates (and radius / geofence if wanted); a real phone test at the branch: check-in and check-out both appear in `ATTENDANCE_EVENTS` with coordinates; employees informed that their location is recorded at check-in and check-out.
5. Parallel run: process one real month in NUTEX and in the current system; reconcile every employee.
6. `npm run backup` scheduled (weekly at least) and a restore rehearsed.
7. Site is reachable over HTTPS only, and `COOKIE_SECURE=true`.
8. Monitoring on `GET /api/health`, `ERROR_LOG`, the dashboard `h_*` health and `cap_*` capacity metrics.
9. Workbook shared with the minimum set of humans.

## Security headers

`next.config.ts` sets a strict CSP (no WebAssembly, no third-party connections), `X-Frame-Options: DENY`, `nosniff`, referrer policy, HSTS in production, and a `Permissions-Policy` that allows only geolocation (for check-in) for the site's own origin and denies camera and microphone.
