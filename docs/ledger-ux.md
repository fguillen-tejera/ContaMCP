# Search, reports, budgets, history, and backups

The agent remains the interface. These tools add no model, bank connection, frontend application,
notification service, or third-party dependency. New tools require `ledger:read`; writes also
require `ledger:write`. Identity always comes from OAuth. Unknown input fields are rejected.
Amounts are exact decimal strings; MXN, USD, and EUR are never combined or converted.
Calendar dates and monthly limits use `America/Mexico_City`.

## Search existing records

`list_entries` and legacy `list_expenses` additionally accept:
- `query`: a literal description substring, 1–100 trimmed characters. Case and common Spanish
  accents are ignored. `%` and `_` are literal characters, not wildcards. This is not semantic search.
- `minAmount` / `maxAmount`: inclusive positive decimal bounds, in major units. Specify currency
  when comparing amounts in one currency. Reversed bounds fail validation.
- `deleted`: `exclude` (default), `include`, or `only`.

Existing inclusive date/type/category/currency/payment-status filters, 25-record default pages,
100-record maximum, and date/ID descending order remain. Keep all filters unchanged with `nextCursor`.
Search finds candidates; corrections and restores still require exact user-supplied identifying facts.
Do not treat a search hit as permission to choose an ambiguous target.

Example: “Busca los gastos de Pemex de octubre entre 400 y 500 MXN.”

```json
{
  "query": "pemex",
  "from": "2026-10-01",
  "to": "2026-10-31",
  "minAmount": "400",
  "maxAmount": "500",
  "currency": "MXN",
  "type": "expense"
}
```

## Category/month reports

`get_ledger_report` requires inclusive `from` and `to`, covering at most 366 calendar days.
`groupBy` is `category` (default) or `month`. It accepts the ordinary ledger filters, including
description/amount bounds and `paymentStatus`. Deleted records are always excluded.

The response contains `current: {from,to,totals,groups}`, nullable `previous`, and `changes`.
Groups have `bucket`, `type`, `currency`, `amountMinor`, `amount`, `count`, and `unverifiedCount`.
Totals contain exact income, expenses, and net per currency; no matches returns empty arrays.
Automatically recorded entries are included unless filtered out. Explain nonzero `unverifiedCount`;
these records are not independently verified bank payments.

`comparePrevious: true` compares the immediately preceding **equal-length** period, using one grouped
SQL query for both periods. For October 1–31, that means August 31–September 30, not September 1–30.
`changes` contains exact signed `incomeDifference`, `expenseDifference`, and `netDifference` per
currency. A currency absent in one period contributes zero. There is no percentage/FX calculation.
Comparisons earlier than 1900 are rejected. Net is not a bank balance or saved money.

```json
{ "from": "2026-10-01", "to": "2026-10-31", "groupBy": "category", "comparePrevious": true }
```

## Explicit currency defaults

`get_preferences` returns `{defaultCurrency,version,timezone}`. Before a preference is saved, currency
is `null` and version is `0`; ask about an unknown currency rather than guessing.

On “Usa MXN por defecto salvo que indique otra moneda,” read preferences and call `set_preferences`
with `{defaultCurrency:"MXN",expectedVersion:0,idempotencyKey:"example-default-01"}`.
Use the current version for later changes; `defaultCurrency:null` clears the preference. Only persist
an explicit user instruction. A transaction or location alone does not establish a default.

In a new conversation, the agent reads the persisted preference and passes that confirmed currency
explicitly to creation tools. An explicitly stated transaction currency always takes precedence.
Legacy tools keep their explicit currency contract. Timezone remains Mexico City and is not inferred
or silently changed by a currency preference. Changes retain before/after receipts.

## Simple monthly category budgets

Create a limit only when requested; do not invent one from spending history. `set_monthly_budget`
takes `{month,category,currency,limitAmount,expectedVersion?,active?,idempotencyKey}`. `month` is
`YYYY-MM` from 1900-01 through 9999-12. Limit is positive and at most 9,999,999,999.99. There is one
budget per owner/month/category/currency. List the month first; version `0` creates a new budget,
and the current version updates an existing one. `active:false` archives it; reactivation retains
the same ID/history. Updating the limit does not rewrite spending or previous budget versions.

```json
{
  "month": "2026-10",
  "category": "groceries",
  "currency": "MXN",
  "limitAmount": "4000.00",
  "expectedVersion": 0,
  "idempotencyKey": "groceries-budget-october-1"
}
```

`list_monthly_budgets` takes `{month,includeInactive?}` and returns every limit for that month
(at most 36 category/currency combinations), with:
- `spentAmount`: live recorded expenses in that calendar month/category/currency.
- `confirmedSpentAmount` and `unverifiedAmount`: the confirmed/automatic-unverified components.
- `remainingAmount`: limit minus recorded spending; it may be negative.
- `overBudget`: true only when spending exceeds the limit; exactly meeting it is not over budget.
- `count`, current version, and budget configuration.

Income, deleted entries, savings allocations, other owners, months, categories and currencies are
excluded. Edits/deletions/restores immediately affect spending. Empty results mean no limits were set.
All budgets are calculated in one joined query. There is no rollover, recurring renewal, envelope
transfer, notification delivery, account balance, or automatic spending restriction.

## History and explicit deletion recovery

`get_activity_history` takes `{kind,entityId,afterVersion?,limit?}`. Kinds are `entry`, `recurring`,
`goal`, and `budget`; pages default to 25, maximum 100. It returns ascending versions as
`{activity:[{version,recordedAt,before,after,details}],nextAfterVersion}`. Use the returned version
to continue. Goal receipts include deposit/withdrawal date, direction, amount and note. Foreign or
missing IDs return the same empty activity. Internal owner IDs are never returned.

For “Restaura el gasto que borré,” first list with `deleted:"only"` and identify the user's target.
`restore_entry` takes `{entryId,expectedVersion,match,idempotencyKey,duplicateConfirmation?}`.
`match` uses the same exact user-supplied facts/ambiguity rules as corrections, against deleted
candidates. Stale/live records fail; potential live duplicates require explicit user review.
The duplicate and unique-target preconditions are rechecked atomically when writing the new receipt.

Restore preserves the ID, financial facts, provenance, recurring linkage and original audit chain,
clears `deletedAt`, and appends the next version. It does not reopen, rewind or advance a recurring
schedule. It does not undo a later correction or import a database backup. Correct a wrong savings
contribution with a compensating allocation as before.

## Bounded exports and complete backups

`export_entries` and expense-only `export_expenses` now accept `{limit?,cursor?,format?}`.
Every response is bounded: default/maximum 100 records. `format` is `json` (default) or `csv`.
Results include `{exportedAt,count,nextCursor,format,consistency:"live"}` and either `entries`
(`expenses` for legacy JSON) or `csv`. **Count is the page count. Follow every nextCursor until null.**
Old clients that assumed a single full dump must update. Ordering is creation timestamp/ID ascending,
including deleted records; the expense filter is applied in SQL before pagination. Do not exchange
cursors between expense-only and mixed exports. CSV pages repeat the header, quote/escape cells, and
prefix formula-like cells with an apostrophe for spreadsheet safety. Use JSON for exact text backups.

`export_backup` accepts `{dataset?,limit?,cursor?}` and returns
`{dataset,exportedAt,consistency:"live",count,records,nextCursor}`. To obtain a complete financial
backup, export all eight datasets and follow every cursor in each:
1. `entries`: live/deleted income and expenses.
2. `recurring`: active/inactive schedule documents.
3. `goals`: active/archived goals and allocation balances.
4. `budgets`: active/archived monthly limits.
5. `preferences`: saved currency preferences.
6. `entry_history`: original entry snapshots, retry keys/request hashes and audit-chain hashes.
7. `planning_history`: original schedule/goal/contribution receipts.
8. `account_history`: original budget/preference receipts.

OAuth credentials, Google subjects, and internal owner IDs are excluded. No automatic import or
database restore is supplied. Cursors are positions, never authorization; every page is owner-scoped.
These are **live pages**, not a transactionally frozen snapshot. Pause manual and automatic writes
when a consistent cross-dataset backup is needed; edits/new records during pagination can change
what subsequent pages contain. Never describe a partial dataset/page as a complete backup.

## Retry, migration, and performance

Every new mutation requires an idempotency key. Budgets/preferences share a separate owner/key
namespace backed by `account_mutations`; avoid reuse across either setting type. Same-key identical
retries return the original receipt even after later changes. Versions prevent lost updates; state
and receipts commit together. Ledger restores share the existing ledger key namespace.

Migration `0006_eminent_wong.sql` is additive: three tables and an owner/creation-date/ID export index.
It preserves existing records and receipt snapshots. Apply pending migrations locally; remote
migrations/deployment still require approval. No new bindings, paid services or dependencies are needed.

Tool schemas are constructed once at module load; servers, handlers and authenticated principals
remain request-local. Reports aggregate in SQL; exports read at most 101 rows for a 100-row page.
The local query-plan regression verifies that exports use `expense_owner_created_id` without a
temporary sort. Recurring results are sorted by due date and ID; use `nextAfterId` plus
`nextAfterDate` to continue, rather than relying on UUID order.

A local Node 24.22.1 synthetic profile on 2026-10-24 measured 30-tool discovery at about 126 KB,
3.9 ms median/5.0 ms P95 wall time across 40 warm samples after five warmups. Server construction
alone measured 0.019 ms median across 200 warm samples. These are local observations, not hosted
Workers CPU or end-to-end agent latency, and are not a before/after speedup claim. Hosted profiling
and real-agent/mobile OAuth trials remain necessary before release; use the existing sanitized CPU
benchmark/probe scripts described in [operations](operations.md).
