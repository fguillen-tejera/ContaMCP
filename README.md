# ContaMCP

An open-source income and expense ledger for Mexico, operated through ChatGPT or another compatible MCP client.
**The agent is the interface. ContaMCP is the trusted system of record and execution.**

The implementation supports income, expenses, possible-duplicate review, recurring payment tracking,
savings goals, search/reports, monthly category budgets, currency preferences, and financial history
through OAuth-protected MCP. New authenticated financial workflows have **not yet
been tested with a real hosted agent**; hosted CPU headroom, recovery validation, and mobile use
remain open gates.

## Implemented features

- Income and expenses with exact per-currency cash flow, owner-only filters, pagination, export,
  audited corrections, soft deletion, and retry protection.
- Possible duplicates pause creation for user review using nearby dates/amounts and similar descriptions.
- Weekly/monthly/yearly recurring entries, recorded automatically on billing dates by default and
  labeled as automatic/unverified. Includes pause/resume, skip, price changes, duplicate review, and
  in-place confirmation or linking of actual payments. No money is moved or reminders sent.
- Savings goals with targets/deadlines, exact explicit contributions/withdrawals, progress, and archive.
- Description/amount search, category/month reports and previous-period comparisons.
- Explicit monthly category budgets and remembered user-approved currency defaults.
- Readable activity history, audited restoration, bounded JSON/CSV exports and complete financial backups.
- ChatGPT plugin and manually added ChatGPT MCP connections go straight to Google sign-in. Other
  MCP apps use a one-button initial approval, remembered for 30 days in that browser.
- Six legacy expense tools remain expense-only. New financial tools require fresh `ledger:read` /
  `ledger:write` consent; existing expense-only grants gain no additional access.

See [financial workflows](docs/financial-workflows.md) and [search, budgets, history, and export contracts](docs/ledger-ux.md)
for examples and limitations. The server exposes 30 tools; budget/default writes require explicit user intent.

All user-requested mutations require `idempotencyKey`; scheduled occurrences use stable internal retry keys. Use the same key and identical input on retries; use a new key
for each new intent. No tool accepts a user ID. Supported currencies are MXN, USD, and EUR (two decimal
places). No exchange conversion or tax calculation is performed. See [tool contracts](docs/tools.md).

No frontend, AI inference, receipts, CFDI processing, banking, billing, R2, or analytics are included.

## Local development

Install Node 24+ and pnpm 10.9.0, then:

```sh
git clone https://github.com/fguillen-tejera/ContaMCP.git
cd ContaMCP
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

This uses only local D1/KV under `.wrangler/`; no Cloudflare account or Google credentials are needed
to run tests or the health endpoint. In another terminal:

```sh
curl http://localhost:8787/health
curl -i http://localhost:8787/mcp
pnpm check
pnpm build
```

Health returns `ok`; the unauthenticated MCP request returns `401` and OAuth discovery information.
Private tools remain inaccessible without OAuth. There is no development authentication bypass.
All resource identifiers in `wrangler.jsonc` are intentionally placeholders: zero values for local
development and placeholder staging/production values until you substitute your own (see
[deploy your own instance](#deploy-your-own-instance)).

For automatic recurring recording, also configure an explicit private `ALLOWED_GOOGLE_SUBJECTS`
allowlist; the job runs only for these owners and fails closed without it. Existing manual schedules
stay manual until explicitly enabled with a next billing date. See [recurring job behavior](docs/financial-workflows.md#job-authorization-limits-and-recovery).

For interactive Google login, copy `.dev.vars.example` to `.dev.vars`, supply your own OAuth credentials,
and follow [authentication setup](docs/authentication.md). Never commit that file.
OAuth browser cookies require HTTPS outside localhost; local HTTP cookie support varies by browser,
so use an HTTPS test deployment for real client testing.

Useful commands:

```sh
pnpm types             # regenerate Worker binding/runtime types after config changes
pnpm db:generate       # generate SQL and Drizzle snapshots after schema edits
pnpm db:migrate:local  # apply pending migrations to Wrangler's persistent local D1
pnpm format           # format supported source/config files
pnpm lint
pnpm typecheck
pnpm test             # Vitest in workerd, actual local D1/KV and MCP requests
pnpm check            # formatting + lint + types + tests
pnpm audit            # includes development tools
pnpm build            # local packaging only; wrangler deploy --dry-run
```

Commit generated SQL, migration snapshots, and `worker-configuration.d.ts`. CI regenerates bindings,
checks migrations on a clean local database, runs the same checks, audits dependencies, and packages
the Worker. It does not deploy or require credentials.

## Architecture and structure

A modular monolith: one Worker, D1 for authoritative records, KV for OAuth. The current MCP SDK's
stateless Fetch handler serves `/mcp`; no Durable Object or session affinity is required. Domain and
application code have no MCP/HTTP dependencies. Hono handles the small OAuth consent/callback surface.

```text
src/
  index.ts          request limits, origin checks, security headers, composition
  auth/             Google OIDC and Cloudflare OAuth provider
  mcp/              thin tool/transport adapter
  domain/           schemas, exact money and calendar rules
  expenses/         ledger, duplicate checks, reports, history and bounded exports
  planning/         recurring payments, savings goals, budgets and currency preferences
  db/               Drizzle schema and D1 adapter
migrations/         generated SQL and Drizzle metadata
test/               MCP, OAuth, financial and persistence integration tests
fixtures/           synthetic Spanish workflows for later agent evaluation
docs/               architecture, setup, contracts and operations
```

See [architecture](docs/architecture.md), [local database/deployment guide](docs/operations.md), and
[engineering standards](AGENTS.md).

## Authentication, privacy, and limitations

Google proves identity; ContaMCP issues its own audience-bound OAuth tokens for MCP clients.
Registrations containing only documented ChatGPT callbacks are preapproved; other clients use
browser-bound app consent protected against framing. See the
[connection policy](docs/authentication.md#chatgpt-plugin-or-manually-added-mcp-server). Google ID tokens
are signature/issuer/audience/expiry/nonce verified. Google access/refresh tokens and profile/email are not stored. Read/write scopes
are enforced in addition to ownership. A subject allowlist is required for staging/production and optional in local development.

Expense contents, original audit snapshots, and Google subject identifiers persist in D1. OAuth grants
and encrypted properties live in KV. Cloudflare account operators can access stored data: this is not
end-to-end encryption. The MCP host sees tool results. There is no telemetry vendor or model service.
Audit history retains previous descriptions and amounts after corrections. Ledger-entry receipts form
a hash chain; `verifyAuditChain` checks complete hashed history against the stored entry. Missing
receipts or hashes fail verification, including legacy history written before hashing existed.
There is no external trusted anchor: an administrator can rewrite both data and hashes, or remove an
entry with all its history. Entry exports are bounded pages, including soft-deleted records. For complete
financial backups, use all eight `export_backup` datasets and follow every cursor. Pages are live; pause
manual and automatic writes for a consistent backup. Account deletion beyond per-record deletion remains future work.

To disconnect a client: remove the ContaMCP plugin/connection in the MCP host (for example ChatGPT),
then revoke its token against the discovered `revocation_endpoint` (RFC 7009) as the acceptance
client does. Access tokens expire after 15 minutes and refresh tokens after 7 days; until revoked,
a stolen token remains usable within those windows. KV consistency means token revocation is not
instantaneous across all locations.

## Deploy your own instance

`wrangler.jsonc` ships placeholder resource identifiers in `env.staging`. To deploy your own staging
Worker: provision a D1 database and KV namespace on your Cloudflare account, replace the placeholder
`account_id`, `database_id`, KV `id`, and `APP_ORIGIN` in `env.staging`, apply migrations with
`pnpm exec wrangler d1 migrations apply DB --env staging --remote`, upload `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `ALLOWED_GOOGLE_SUBJECTS` as secrets with Wrangler's interactive commands,
then deploy with `pnpm exec wrangler deploy --env staging`. Never paste credentials into shell
arguments or committed config. Five low-volume testers should fit request/storage allowances on the
Free plan; free-plan CPU limits and OAuth/KV write rates still need hosted measurement. See
[operational estimates](docs/operations.md) and [authentication setup](docs/authentication.md).

For a real end-to-end check, run the [authenticated MCP acceptance client](docs/mcp-integration-testing.md)
against your deployment.

For an allowlisted production pilot, follow the [production rollout guide](docs/production.md).
`env.production` has separate resource placeholders and rate-limit namespaces; its Cron trigger stays
off until rollout validation is complete. `pnpm build:production` checks packaging locally and in CI.
The template and dry run do not establish hosted readiness or configure a Google OAuth client.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[public release checklist](docs/open-source-release.md). MIT licensed; dependencies retain
their own MIT/Apache licenses. No third-party source code or data is redistributed.
