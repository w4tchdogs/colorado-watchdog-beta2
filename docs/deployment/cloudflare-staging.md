# Cloudflare staging Worker

This configuration is separate from `wrangler.sites-test.toml`. It deploys the
existing Sites Worker build to a `workers.dev` URL with a production runtime
and authentication, Turnstile and guest intake disabled. It does not declare
custom routes or domains.

## Operator inputs

Set these in the operator environment; do not commit resource identifiers:

| Variable | Value |
| --- | --- |
| `WATCHDOG_STAGING_ACCOUNT_ID` | The intended Cloudflare account ID |
| `WATCHDOG_STAGING_D1_ID` | The fresh Website D1 database UUID |
| `WATCHDOG_STAGING_R2_BUCKET_NAME` | The private staging R2 bucket name |

The generator currently refuses any account except the explicitly approved
staging account. It writes the Wrangler config and wrapped migration files
under the ignored `.wrangler/` directory. Each wrapped migration adds the
application `schema_migrations` row in the same D1 migration, using SHA-256 of
the source SQL after CRLF/CR normalization to LF.

## Rehearse and stage

Run `npm ci`, `npm run build`, `npm run test:d1`, and
`npm run test:sites:d1` first. The D1 rehearsal must pass before remote writes.
Then set the operator inputs, run `npm run cloudflare:staging:config`, inspect
the generated config locally, and confirm the remote database is fresh before
running:

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply colorado-watchdog-alpha1-staging --config .wrangler/wrangler.cloudflare-staging.toml --remote
node scripts/verify-cloudflare-staging-d1.mjs
npm run build
node node_modules/wrangler/bin/wrangler.js deploy --config .wrangler/wrangler.cloudflare-staging.toml
```

The verifier checks both the Website application ledger and Wrangler's
`d1_migrations` history, then compares all 64 live county/FIPS pairs with the
canonical inventory in migration 0015. Wrangler captures its D1 backup after
applying migrations. Keep the private Profiles database local.
