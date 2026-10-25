# Operations and recovery

This guide covers local database safety, hosted operational controls, recovery, and Cloudflare Free
plan expectations. All hosted changes, including provisioning, migrations, secret changes, rollback
and restore, should follow your own deployment approval process.

See [production setup and rollout](production.md) for the isolated production environment. The
controls below apply to both hosted environments; commands shown with `--env staging` target staging
only. Use the approved production config and `--env production` explicitly for production operations.

## Local financial extension rollout

The current source includes additive provenance migration `0005_loud_spyke.sql`, automatic recurring
recording, and recurring control tools. Migration `0006_eminent_wong.sql` adds budgets/preferences,
their audit receipts, and an indexed bounded-export path. Apply all pending SQL before the Worker version.
For future rollouts, use the [financial rollout procedure](financial-workflows.md#staging-rollout).
No new remote resources or paid services are required. Existing expense-only grants stay narrow;
reconnect clients for ledger scopes. Re-measure hosted discovery and mutation CPU before widening access.

## Local database and migration safety

`pnpm db:migrate:local` applies committed SQL to local D1 under `.wrangler/state`; `pnpm dev` uses
that state. `pnpm db:migrate:staging:local` uses the distinct staging binding locally. Neither
provisions resources. `pnpm test` uses separate ephemeral workerd D1/KV and synthetic identities.
`/health` is process health, not a migration/readiness or Google connectivity probe.

The initial migration creates tables and indexes; later features have versioned additive migrations. The expense/audit
writes use one transactional D1 batch. Unique owner/retry keys serialize concurrent retries; unique
expense/version receipts serialize competing corrections. All reads and updates are scoped by the
verified owner, including conflict recovery and pagination. Money remains integer minor units;
aggregate sums cross the JavaScript boundary as exact strings. Do not enable D1 read replication for
this trial: session/bookmark consistency would require its own review and tests.

After schema changes, generate a new migration using `pnpm db:generate`, review SQL and commit snapshots.
Never edit a shared applied migration or use schema push against staging. Test fresh application and
reapplication locally, check pending migrations before and after remote application, and plan schema
compatibility with old Worker versions. Code rollback cannot undo SQL or restore ledger/audit records.

## Minimal staging controls

- Closed subject allowlist in staging, HTTPS canonical host and strict browser Origin checking.
- Google and downstream OAuth S256 PKCE; signed Google ID-token verification and audience-bound MCP
  credentials. Fifteen-minute access tokens, seven-day refresh grants. Google tokens are not persisted.
- Bounded 16 KiB request bodies and 100-record list pages. No automatic retry that changes mutation keys.
- Rate bindings: OAuth aggregate 20 requests/minute/location; MCP ingress aggregate and each verified
  user 120 requests/minute/location. Authentication precedes the user-key limiter. Failures return
  429 with `Retry-After:60`; limiter failures fail closed. These approximate counters protect a quiet
  pilot, not a global quota or a strong distributed attack boundary. Anonymous MCP checks the limiter
  before KV.
- OAuth errors emit safe error codes. Application diagnostics contain only a fixed event and random
  request ID; every response includes `X-Request-Id` and no-store. Responses use no-referrer except
  the consent form, which uses strict-origin so native POSTs retain a verifiable Origin without
  exposing URL paths or queries. Tool failures expose
  no SQL, stack, parameters, amounts or descriptions. Expected validation/conflict errors remain useful.
- CIMD is disabled to avoid the installed library's direct logging of client-supplied URLs; DCR works.
  The dependency also has rare internal maintenance warnings; do not expand logging of caught errors
  or enable generic request/SQL debug logs when diagnosing them.

Observability keeps console logs sampled at 10%, query redaction on, invocation logging off, tracing
off. Missing log entries are possible by design. Traces would expose OAuth/database spans without a
separate privacy review. This deliberately limits the general Workers skill's tracing recommendation
to meet the repository's sensitive-data requirements. Use dashboard aggregate metrics for CPU/errors,
D1 rows/storage and KV operations. Do not collect bodies, Authorization/Cookie headers, callback query
strings, subject IDs, SQL bindings, live tail dumps or browser HARs. If temporarily increasing console
sampling for a synthetic trial, keep invocation logs/traces disabled and review the actual fields.
See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Recovery procedure

For an outage, inspect status/event/request ID and aggregate metrics first. A 503 setup error means
credentials/allowlist/origin need correction; 429 means back off; repeated 1102 means stop the trial and
profile CPU. Never turn off authentication to diagnose a failure. To close access, deploy an allowlist
containing only a nonmatching sentinel, such as `disabled`, using interactive secret management. This
blocks previously issued token identities on every request, independently of KV revocation. Disabling
a route in Cloudflare is an additional operator option for public endpoint abuse. Both are external
changes requiring approval. An in-flight request can still complete.

Before a later migration or risky staging change, capture a D1 bookmark and the deployed Worker version:

```sh
pnpm exec wrangler d1 time-travel info DB --env staging --json
pnpm exec wrangler deployments list --env staging
pnpm exec wrangler versions list --env staging
```

To recover code only, review schema compatibility and bindings/secrets of the chosen version, then:

```sh
pnpm exec wrangler rollback REVIEWED_VERSION_ID --env staging
```

To recover data, pause writes/access first; identify a known-good bookmark within the Free retention
window. After a reviewed restore decision:

```sh
pnpm exec wrangler d1 time-travel restore DB --env staging --bookmark REVIEWED_BOOKMARK
```

Time Travel commands operate on remote databases; there is no `--remote` switch on these commands.
Save the pre-restore bookmark printed by the operation so an erroneous restore can be undone. Worker
rollback, D1 restore and KV state are separate. Restoring D1 rolls back both expenses **and** audit/retry
receipts; retries for mutations after the bookmark could execute again. Keep clients stopped, reconcile
lost synthetic intents, and require a fresh login before resuming. Never restore just one ledger table.
Free Time Travel retention is seven days; execute a reversible synthetic-record drill on staging and
record its result before real financial data. See [D1 recovery](https://developers.cloudflare.com/d1/reference/time-travel/).
No restore drill is claimed locally.

OAuth KV is disposable credential state, not the financial authority. If compromised, close the pilot,
rotate the relevant Google secret, invalidate grants or replace the deployment's KV, and
require new logins. Do not export token/grant contents for incident reports. D1 users/expense/audit data
must survive credential-state replacement. KV revocation/state consumption is eventually consistent;
sequential local replay tests do not prove globally atomic consumption or immediate global revocation.
The library retains a previous refresh token to tolerate concurrent refreshes; do not claim strict
single-use refresh replay detection. Ledger idempotency relies on D1, independently of those KV limits.

Nonfinancial post-migration/trial checks (remote reads count against quotas):

```sh
pnpm exec wrangler d1 migrations list DB --env staging --remote
pnpm exec wrangler d1 execute DB --env staging --remote --command 'PRAGMA foreign_key_check'
pnpm exec wrangler d1 execute DB --env staging --remote --command 'SELECT COUNT(*) AS expenses FROM expenses'
pnpm exec wrangler d1 execute DB --env staging --remote --command 'SELECT version, COUNT(*) AS receipts FROM expense_mutations GROUP BY version'
```

Do not select/export descriptions or tokens for diagnostics. Before wider use, owner-scoped export,
deletion/retention policy, privacy review and a recovery drill remain necessary. There is no reset
script supplied; treat any resource reset as a deliberate operation.

## Expected Free usage and remaining CPU gate

Workers Free allows 100,000 requests/day and 10 ms CPU/request. Network waits do
not count as CPU; low volume does not excuse exceeding the per-request limit. Measure cold and warm
Google callback/token exchange, discovery, initialize, tool listing, create/update/list/summary and
refresh in a sequential synthetic staging run. Use dashboard CPU percentiles/max and invocation error
outcomes, especially `exceededCpu`/1102; record sample size/time window, not payloads. If the dashboard
lacks route-level breakdown, isolate each action into its own quiet measurement window. Local test
latency or package/startup size is not a CPU measurement. Profile locally before considering any paid
plan. Cloudflare documents rollover CPU allowance, so P99 above 10 ms can occur without an invocation
error. See
[metrics interpretation](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

D1 Free includes 5 million rows read/day, 100,000 written/day and 5 GB account storage; indexes contribute
to writes and storage. Summaries scan the owner's matching records. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
KV Free includes 100,000 reads/day, 1,000 writes/deletes/lists of each type per day, and 1 GB storage.
OAuth—not expense volume—can exhaust the smaller write/delete allowances. Quota excess fails operations
on Free; KV also limits repeated writes to one key. See [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

Five testers doing 20 mutations and 50 read calls each/day produce about 350 tool invocations plus MCP
initialization, discovery, token exchanges and refresh. That is roughly 200 base expense/audit row writes
plus index writes, well below ledger row quotas for a small database. Token verification performs KV
reads per authenticated request; initial login uses consent/upstream/client/grant/token writes and
cleanup deletes. Estimate fewer than a few hundred OAuth writes/day for a few logins and a few hours
of activity per tester, then verify dashboard counts. Continuously refreshing every fifteen minutes
across many devices/clients can exceed 1,000 KV writes/day; public DCR abuse can do so as well.
The limiter is not a daily budget, and quotas are shared with other account projects.

Expected incremental hosting charge is $0 **if the account stays on Free and remains within limits**.
Do not select a paid Workers plan to bypass CPU failures. A paid/shared account can incur overages;
Google paid APIs, new domains, optional telemetry exports and subscription upgrades are outside this
milestone. No external inference or observability dependency was added. Confirm Rate Limiting binding
availability on the chosen account before deployment; if provisioning requests an upgrade, stop for
explicit cost approval. Recheck [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and the [binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
at deployment time.

## Automatic recurring job

The Wrangler templates declare `0 * * * *` in both root and staging. The scheduled handler checks the
Mexico City calendar and processes at most five due occurrences per run, with stable per-occurrence
keys and atomic ledger/audit/schedule writes. This is automatic bookkeeping, not payment execution.
Apply migration 0005 before enabling the new Worker. Existing manual schedules do not switch modes.

The private `ALLOWED_GOOGLE_SUBJECTS` must explicitly list the owners eligible for background work;
this is mandatory for scheduled processing even locally. Missing configuration fails closed.
Paused/manual schedules and duplicate-blocked schedules are excluded. A failed job can be retried
without duplicate financial writes; successful occurrences remain recorded if a later one fails.
Check fixed `automatic_recording_failed` diagnostics and aggregate CPU/errors without dumping data.
A `needsReview` schedule needs owner confirmation/linking or an explicit skip. No automatic merge or
delete occurs. Removing an owner from the operational allowlist stops their future scheduled work.

Before a restore, stop both client writes and the Cron Trigger or close the job's owner allowlist.
Restoring ledger, financial receipts, schedule state and planning receipts must be coordinated:
restoring a past due date without its occurrence receipt could cause another posting. A code rollback
to the earlier version stops automatic processing but does not undo already recorded charges; the
old scheduled trigger must also be removed or reviewed. Measure hosted Cron CPU before wider access.

## Export and configuration safety

Entry exports now return at most 100 records per page; consumers must follow every `nextCursor`.
Use all eight `export_backup` datasets to include planning/configuration and original receipts.
These are live reads. Pause user and automatic writes for a consistent cross-dataset backup; no
automatic import/restore is implemented. See [ledger UX contracts](ledger-ux.md). Budget/preference
state and `account_mutations` are authoritative and must be restored together, just like ledger
state and its retry receipts. Never expire configuration receipts independently.
