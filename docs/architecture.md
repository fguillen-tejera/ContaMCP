# Architecture

ContaMCP is a modular monolith. A verified OAuth request reaches the MCP adapter, which validates tool
input and calls an expense service with an explicit principal. The service uses a small typed
storage contract implemented by Drizzle/D1. It has no transport, framework, or runtime binding dependency.
This small contract permits reuse without a repository hierarchy, container, or generic base classes.

`src/mcp/handler.ts` composes the server and transport. Tool registrations live in `expenses.ts`
(legacy expense tools), `entries.ts`, `recurring.ts`, `goals.ts`, and `insights.ts`. Shared MCP annotations
and output schemas live in `contracts.ts`; `results.ts` enforces tool scopes and safe error responses.
Registration functions receive the store, verified principal, and diagnostics explicitly.

Within `src/planning/`, `recurring.ts` owns schedule creation, payment confirmation and schedule controls;
`goals.ts` owns savings goals and allocations. Both use `mutations.ts` for retry receipts and atomic
commit recovery. `automatic.ts` runs authorized recurring work, and `budgets.ts` handles budgets and
currency preferences. Business rules remain independent of MCP and database adapters.

## Decisions and invariants

- **Stateless transport, persistent business state.** `@modelcontextprotocol/server` 2.3.1's
  `createMcpHandler` creates a server for each request. Current protocol traffic and stateless 2025
  Streamable HTTP clients share the tools. No deprecated standalone SSE, `McpAgent`, session storage,
  or Durable Objects. No globals contain a user, token, or ledger state.
- **One Worker for authorization and resources.** `@cloudflare/workers-oauth-provider` 1.2.4 explicitly
  supports this shape. Splitting authorization into another service is unnecessary for this product.
  Google OIDC establishes a stable subject; users are unique by that subject, never by mutable email.
- **Explicit trust boundary.** The OAuth library verifies tokens and audience; the adapter validates
  the authenticated context, checks subject consistency and pilot allowlist, and enforces read scope.
  Each tool enforces its additional scope. Every query includes owner ID from that context.
- **Exact money.** Amounts arrive as canonical decimal strings without symbols or grouping. BigInt
  converts to integer cents, stored as SQLite INTEGER. Individual values are capped at
  9,999,999,999.99, within JS's safe integer range. There is no decimal floating-point multiplication.
  SQLite integer `SUM` is cast to text before leaving D1, then formatted with BigInt; totals never pass
  through a JS Number. SQLite's signed 64-bit sum overflow returns an error, never an approximate total.
  Every total has its own currency; only MXN/USD/EUR are currently supported.
- **Dates.** Expense dates are calendar dates, not timestamps; filters are inclusive. Omitted create
  date means today in `America/Mexico_City`. UTC ISO timestamps record mutation times. Invalid dates
  fail validation and a SQLite constraint. The client must clarify ambiguous relative dates.
- **Explicit categories.** Category is required; explicit `other` is available. Categories are
  descriptive bookkeeping labels without tax/deductibility meaning. No keyword classifier or model.
- **Corrections are explicit.** Update needs ID, expected version and nonempty changes. The same
  `NOT_FOUND` response covers another owner's record and an absent record. Versions prevent lost
  updates; there is no "last expense" global or fuzzy target selection.
- **Atomic audit and idempotency.** Each expense starts at version 1 with a mutation receipt. Every
  correction inserts exactly the next version. `(expense_id, version)` is unique; `(owner_id, key)` is
  the receipt primary key. Drizzle's D1 batch commits the write and receipt together. A second concurrent
  correction cannot acquire the same version receipt, so its entire batch rolls back. The update also
  checks ownership/version. This invariant assumes all financial writes use the service; direct SQL
  administration must preserve it. The receipt includes before/after snapshots, owner, time and request
  hash. A replay returns the original snapshot even if the expense was subsequently corrected.
  The hash covers the validated operation/input before defaulting dates or generating IDs. Keys are
  scoped per owner across both mutation tools and retained with the audit history.
  Cached receipts enforce the entry-type restriction too; a legacy expense tool cannot replay an
  income receipt through the shared ledger retry namespace.
- **Bounded work.** Request bodies are streamed into a maximum 16 KiB buffer before parsing. List
  pages contain at most 100 records plus one lookahead. Keyset pagination uses `(date, id)` descending;
  cursors are validated and never authorize access. Keep the same filters across pages. Concurrent
  date edits may move records between pages; this is not a consistent export snapshot. Summary scans
  matching records in SQLite rather than loading them into the Worker.

## Storage

`verifyAuditChain` reads entries and receipts in one D1 batch, checks contiguous versions from creation,
before/after continuity, receipt hashes and links, and equality of the final snapshot with the stored
entry. Snapshots are hashed as originally persisted; newer schema defaults are applied only for state
comparisons. A missing hash, including a legacy receipt from before migration 0003, returns `valid:false`:
that history is unverifiable, not necessarily corrupt. Do not rewrite old snapshots to make it pass.
This detects inconsistencies in retained entry history; without an external trusted anchor it cannot
prove integrity against an administrator rewriting hashes or removing an entry and all its receipts.
Planning and account receipts are transactional audit records without this hash chain.

`users`: UUID, unique Google subject, created timestamp.
`expenses`: UUID, owner FK, description, integer amount, currency, date, required category, version,
timestamps. Owner/date/ID and owner/category/date indexes support the first filters.
`expense_mutations`: owner/key, request hash, expense FK, unique version, before/after JSON, timestamp.
The composite FK also ensures audit ownership matches expense ownership.

Drizzle Kit SQL and snapshots are committed in `migrations/`. Wrangler applies SQL locally/remotely;
tests apply the identical migrations to workerd D1. Fixtures are synthetic only; no production data
is committed.

## Verification and intentionally deferred work

Vitest runs inside workerd with actual D1/KV. MCP tests use the official SDK client and real local OAuth
tokens, including independent connections, concurrent requests and scope restrictions. One auth test
follows consent → mocked Google (real synthetic RSA signature) → token exchange → authenticated write.
Negative tests verify identity claims, cookies, revocation, origin restrictions and financial constraints.
Spanish workflow fixtures are authored expectations, not measured agent performance or a live demo.

External OAuth configuration, real ChatGPT/mobile compatibility, CPU profiling under Workers Free,
broader agent validation and a recovery drill remain release gates. No production readiness or
measured usage claim.

## Official references checked 2026-10-23

- [MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and installed 2.3.1 type declarations.
- [Cloudflare transport guidance](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/).
- [OAuth provider](https://github.com/cloudflare/workers-oauth-provider), including consent/upstream guides.
- [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).
- [D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- [Drizzle D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1); stable 0.45.4 ORM/0.31.11 Kit,
  avoiding release candidates. Kit's deprecated esbuild loader is transitive development tooling; a
  scoped pnpm override updates its vulnerable esbuild without changing the runtime dependencies.
- [Cloudflare Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/); use the
  maintained `@cloudflare/vitest-plugin`, which replaced `@cloudflare/vitest-pool-workers`.

## Staging boundary

One Worker and D1/KV; `env.staging` explicitly binds isolated resources and fails closed
until Google credentials/subject restrictions exist. Ingress/OAuth/user rate limits use native bindings.
A request-local diagnostic object carries only a random correlation ID and fixed event names; adapters
receive it explicitly, and domain/ledger services do not depend on logging, HTTP or MCP. The independent
OAuth test CLI is under `scripts/`, never imported by the deployed Worker.

## Local financial extensions

The existing ledger stores both income and expenses with an immutable type and nullable recurring
occurrence linkage. Legacy MCP tools enforce expense-only access; new tools require new ledger scopes.
Creation uses an owner/type/currency/date/amount/description duplicate probe and an atomic receipt
precondition so a concurrent unacknowledged candidate cannot slip past the initial lookup. User-approved
candidate IDs/versions are part of the mutation's retry hash. Description similarity is a bounded
heuristic, not semantic certainty.

`src/planning/` contains transport-independent recurring/savings/budget/preference application functions.
`src/domain/planning.ts` defines strict schemas and anchored calendar recurrence. `src/db/planning.ts`
stores owner/version-scoped validated documents and immutable before/after planning receipts. Payment
confirmation/linking commits the ledger receipt, ledger change, schedule receipt, and schedule advance
in one D1 batch. One occurrence can be linked once; expected versions serialize confirmations/cancel.
Goals retain exact explicit allocation balances and contribution audit details independently of ledger
income/expenses. The scheduled handler performs bounded owner-allowlisted automatic bookkeeping. No money is moved or reminders sent. See
[contracts, limitations, and rollout](financial-workflows.md).

## Automatic recurring recording

A persisted user-established schedule is a standing instruction. New schedules default to automatic;
pre-existing JSON documents decode as manual. The scheduled composition layer resolves only users
whose verified subjects are explicitly in the private allowlist. `src/planning/automatic.ts` receives
these authorized owner IDs through explicit dependencies and performs owner-scoped work in round-robin
order, at most five occurrences per hourly run. No HTTP route can invoke the production scheduler.

Automatic entries retain source/status fields and are included in ordinary totals, with an
`unverifiedCount` breakdown and a confirmed-only filter. Creation uses the same duplicate and atomic
receipt checks as manual financial writes; the receipt also checks current active/automatic schedule
version. A duplicate creates an audited review marker without advancing the due date. Manual
confirmation reconciles the same entry with actual amount/date, retaining source and audit history.
The additive migration preserves prior snapshots and hashes; old receipt replays decode new defaults.
The recurring control tools remain scoped to ledger write permission, with expected versions and
idempotency. Scheduled processing needs no active OAuth token: its authority is the saved standing
instruction plus the operator's explicit owner allowlist.

## Queries, configuration, and bounded recovery

Search/report/history/export services remain transport-independent. Reports perform one exact grouped
SQL query for current/previous periods; amount bounds use integer cents and search parameters remain
bound. All list/export pages are bounded. Exports use the owner/creation-date/ID index, with explicit
live-page consistency; they do not promise a cross-request snapshot. New modules reuse immutable
schemas at module scope while all server instances and principal closures remain request-local.

`monthly_budgets` has one owner/month/category/currency row; `user_preferences` has one owner-approved
currency default. `account_mutations` preserves their before/after snapshots and owner/key retry
receipts. Updates and receipts commit in one D1 batch with version guards. Budget progress uses a
single left join against owner/category/currency/date-scoped live expenses and never changes the ledger.

Restoration appends the next ledger version and retains hash linkage. Its exact deleted-target and
live-duplicate checks run again inside the receipt statement, closing query/write races. Recurring
associations survive restoration, while schedule advancement remains untouched. See
[complete user-facing contracts](ledger-ux.md).

## ChatGPT authorization-code recipient policy

After OAuth request validation, `src/auth/chatgpt.ts` checks the selected return address against the
server-side registration and requires all registered return addresses to be supported ChatGPT
callbacks. Such requests begin the fresh browser-bound Google flow immediately. Other clients use
the existing one-button approval/remembered-approval flow. This is a preapproval policy for code
delivery to ChatGPT; it does not use headers or self-asserted metadata as authenticated identity.
The downstream token exchange still binds client, exact redirect, resource and S256 verifier; Google
verification remains the sole source of the ledger owner. No registration/lookup shortcut grants a
user identity, token, or ledger operation. See [setup and policy](authentication.md).
