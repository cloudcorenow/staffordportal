# Stafford Account and Letter Portal

A workspace for maintaining collection accounts, generating letters from the Stafford templates, attaching ledgers, and recording when each letter was actually sent. It works alongside SimplicityCollect and matches accounts by Simplicity account number; it does not connect to Simplicity.

It runs entirely on Cloudflare:

| Piece | Used for |
|---|---|
| **Workers** (+ static assets) | The web app and its API, in one Worker |
| **D1** (SQLite) | Accounts, letters, templates, users, sent-date corrections, change history |
| **R2** | Ledger files (`ledgers/…`) and nightly backups (`backups/…`) |
| **Access** (Zero Trust) | Sign-in. The Worker also verifies the Access token on every API request |
| **Cron Trigger** | Nightly backup to R2 at 10:00 UTC |

## What protects the records

- **Roles.** *Admin*: everything, including templates, users and backups. *Staff*: accounts, letters, sent dates, ledgers, CSV import. *Viewer*: read-only. Roles are enforced by the Worker, not just hidden in the page.
- **Generated letters are fixed copies.** Database triggers block any change to a letter's content or deletion of a letter. Only its sent date can change afterwards.
- **Sent-date corrections** require a reason and are stored in their own table, which can't be edited or deleted.
- **Append-only change history.** Every change is written in the same transaction as its history entry. Each entry includes a SHA-256 hash of its content and the previous entry's hash, so an edit made outside the app (for example in the D1 console) is detected by **Users and backups → Check change history**, and by each nightly backup.
- **Template verification.** Letters print marked "Unverified template" until an admin confirms the template matches the approved Word original. Changing a template's wording clears that confirmation.
- **Backups.** Every table is exported nightly as gzipped NDJSON to `backups/<timestamp>/` in R2, with a `manifest.json` (row counts and the history check result). Old backups are pruned after `BACKUP_RETENTION_DAYS`. D1 Time Travel separately keeps 30 days of point-in-time history.
- **Browser hardening.** A strict Content-Security-Policy (`public/_headers`), no third-party scripts (the PDF libraries are vendored in `public/vendor/`), no framing, and every write must carry an `X-Portal-Request` header so other sites can't submit forms to the API.

## Set up and deploy

You need Node.js 18+ and a Cloudflare account with Workers, D1, R2 and Zero Trust (Access) enabled. Check current plan limits and pricing for your number of staff.

```bash
npm install                       # also generates worker-configuration.d.ts
npx wrangler login

npx wrangler d1 create stafford-portal
#   Copy the database_id it prints into wrangler.jsonc.
npx wrangler r2 bucket create stafford-portal-files
npm run db:migrate:remote
```

### Cloudflare Access

1. Choose the hostname, for example `portal.staffordga.com`, and add it as a **custom domain** on the Worker (Workers & Pages → stafford-portal → Settings → Domains & Routes). Turn off the `workers.dev` route so the portal is only reachable through Access.
2. In **Zero Trust → Access → Applications**, add a **Self-hosted** application covering that hostname (the whole site, not just `/api`). Add a policy that allows your staff, for example by email domain or a list of emails.
3. Copy the application's **Audience (AUD) tag**.
4. In `wrangler.jsonc` set:
   - `ACCESS_TEAM_DOMAIN`: `https://<your-team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag
   - `BOOTSTRAP_ADMINS`: your email (comma-separate several). These people become admins on first sign-in; everyone else is added from **Users and backups**.

```bash
npm run deploy
```

Sign in, then open **Letter templates**, compare each template's printed output with the approved Word original, and select **Mark as verified**.

If `ACCESS_AUD` is empty, the deployed Worker refuses every API request. It never falls back to an unauthenticated mode outside `localhost`.

## Local development

```bash
cp .dev.vars.example .dev.vars    # DEV_USER_EMAIL signs you in on localhost only
npm run db:migrate:local
npm run dev                       # http://localhost:8787
```

Trigger the backup locally with `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

`npm run typecheck` checks the Worker. `npm run test:e2e` runs the browser test (needs Python with Playwright) against a running `npm run dev` on an **empty** local database: delete `.wrangler/state` and re-run the local migration first.

## Restoring

- **Recent mistakes or data loss:** use D1 Time Travel, which can restore the database to any minute in the last 30 days.
  ```bash
  npx wrangler d1 time-travel info stafford-portal
  npx wrangler d1 time-travel restore stafford-portal --timestamp=<ISO time or Unix timestamp>
  ```
- **Older than 30 days, or an offline copy:** the nightly R2 backups hold every row of every table. Download a backup folder from the R2 dashboard; each `*.ndjson.gz` file has one JSON row per line in the table's own column names, ready to load back with `INSERT` statements. Ledger files themselves stay in R2 under `ledgers/` and aren't duplicated by the backup.

## Project layout

```
wrangler.jsonc            Worker, D1, R2, cron and Access settings
migrations/0001_init.sql  Schema, append-only triggers
src/index.ts              API routes, letter generation, ledgers, backups
src/auth.ts               Access token verification and roles
src/audit.ts              Hash-chained change history
src/util.ts               Helpers
public/index.html         App shell
public/js/app.js          The portal UI
public/js/shared.js       Validation, CSV parsing and letter merging, shared by the Worker and the browser
public/js/templates.js    Letter 1 layout from Stafford_New_1st_Notice.docx
public/css/               App and letter styles
public/vendor/            html2canvas 1.4.1 and jsPDF 2.5.1 for PDF downloads (MIT licensed)
public/_headers           Security headers for the static files
test/e2e.py               End-to-end browser test
```

## Limits worth knowing

- CSV imports take up to 5,000 accounts at a time. The whole file is written in one transaction with bulk statements (about a dozen database queries for 5,000 rows), so it imports completely or not at all. Large imports need the Workers Paid plan: the free plan's CPU and D1 query limits are too small for files this size.
- Batch letters are generated in groups of 100 automatically. Very large batches (hundreds of letters) are better printed directly than turned into one PDF.
- The account and batch lists show 200 rows at a time with a "Show more" button; search and filters cover every account.
- Ledger uploads are limited by `MAX_UPLOAD_MB` (25 MB by default).
- The app loads all accounts and letter summaries when it opens. With 5,000 accounts that took about a second locally. If the book grows into the tens of thousands, the account list should move to server-side search and paging.
- Downloaded PDFs store each page as an image. For text you can select, use **Print → Save as PDF**.
- `compatibility_date` is set to 2026-10-13. If your Wrangler version doesn't support that date yet, it uses the newest date it does support.
