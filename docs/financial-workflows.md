# Income, duplicates, recurring payments, and savings

These features have not yet been evaluated with a real hosted agent. Recurring entries can be
recorded automatically, but no money is moved or bank payment independently verified. There are no
reminders, account balances, net worth, or CFDI processing.

## Permissions and compatibility

New tools require `ledger:read`; mutations also require `ledger:write`. Reconnect and explicitly grant
these permissions before using them. Existing `expenses:read` / `expenses:write` grants retain their
expense-only permissions and do not gain access to income or goals. Consent describes all four scopes.
To use both the new and legacy tools, grant both scope pairs. Authentication still determines the
owner, and every database operation is owner-scoped.

The six legacy expense tools remain available. `create_entry`, `list_entries`, `update_entry`,
`delete_entry`, `get_cash_flow`, and `export_entries` provide the mixed ledger. Existing stored records
become `type: "expense"`; migration preserves amounts, IDs, versions, and original audit snapshots.
Internal table/function names retain `expenses` to avoid a destructive rename.

## Income and cash flow

`create_entry` takes the existing expense creation fields plus required `type: "income" | "expense"`.
Amounts remain positive decimal strings in explicit MXN, USD, or EUR. Example:

```json
{
  "type": "income",
  "description": "Proyecto de diseño",
  "amount": "15000.00",
  "currency": "MXN",
  "date": "2026-10-23",
  "category": "other",
  "idempotencyKey": "design-project-income-20261023"
}
```

Categories remain the existing bookkeeping labels; use `other` for income without a fitting label.
They are not fiscal classifications. Ask about transfers/refunds rather than silently labeling them
income. A transfer between the user's own accounts is not income or an expense.

`list_entries` accepts `{type?,recurringId?,paymentStatus?,from?,to?,category?,currency?,query?,minAmount?,maxAmount?,deleted?,limit?,cursor?}` and returns
`{entries,nextCursor}`. Dates are inclusive; pages default to 25 and are bounded at 100. Keep filters
unchanged when paging. Each entry includes `type`, nullable `recurringId`/`occurrenceDate`, `source: "user" | "recurring"`,
and `paymentStatus: "confirmed" | "unverified"`. Automatic entries retain their recurring source
after later confirmation; the audit preserves their original status.
`export_entries` returns bounded JSON/CSV pages, including soft-deleted entries. `count` is the
page count; follow `nextCursor` until null. See [exports and complete backups](ledger-ux.md#bounded-exports-and-complete-backups).

`update_entry` and `delete_entry` take `entryId`, `expectedVersion`, `match`, and `idempotencyKey`;
updates also require nonempty `changes`. Legacy expense tools retain their `expenseId` argument. `match.type`
can disambiguate income from expenses; correction candidates are always scoped to the selected type.
Type is immutable: correct a mistaken type by explicitly deleting and recreating the entry. Linked
recurring IDs/dates cannot be edited through these tools. Corrections/deletions preserve their audits.

`get_cash_flow` accepts date/category/currency/recurringId filters and returns:

```json
{
  "totals": [
    {
      "currency": "MXN",
      "income": "15000.00",
      "expenses": "17000.25",
      "net": "-2000.25",
      "unverifiedCount": 2
    }
  ]
}
```

All totals use exact cents. Net is recorded income minus recorded expenses, including automatic
entries. `unverifiedCount` identifies automatically recorded amounts not yet confirmed by the user;
use `paymentStatus: "confirmed"` for confirmed-only totals. `get_expense_summary` also returns
`unverifiedCount` per currency. Net is not savings or an account balance. Future expectations and
savings allocations never enter these totals. Currencies are never
combined or converted; no matches returns `totals: []`.

## Possible duplicates

Creation checks for live records with the same owner, type, and currency, within three calendar days,
with amounts within 5% of the proposed amount (minimum tolerance one cent), and overlapping description terms. Description
matching ignores case/common Spanish accents and some common filler words; it is a deterministic
heuristic, not semantic understanding. It can flag legitimate repeats and miss paraphrases. It checks
up to 12 distinct terms of at least three characters; at least half must occur in the candidate's
normalized description. Descriptions with no usable terms use case-insensitive trimmed equality.
For nearby automatic/unverified entries the amount tolerance is relaxed: a reported price change
should reconcile the existing occurrence rather than silently create a second expense. Date/name
matching remains a heuristic, so the agent should inspect known subscription history first.

A new retry key does not bypass this check. `POSSIBLE_DUPLICATE` returns
`{error:{code,message,candidates:[entry,...]}}` without writing any ledger or audit record. The agent
must show the candidates and ask whether this is a separate transaction. Only after user confirmation,
retry with `duplicateConfirmation: [{id,version}, ...]` acknowledging every candidate. Confirmation is
bound to the proposed entry through its mutation receipt; changed inputs after a successful write
produce `IDEMPOTENCY_CONFLICT`. After a warning with no write, the same key may be reused with the
confirmation. Never auto-fill confirmations or auto-merge/delete existing records.

The candidate check is repeated atomically in the insertion receipt. Newly appearing or changed
candidates require another review. At most 20 candidates can be acknowledged; more matches produce
`INVALID_INPUT` and require reviewing the existing entries instead of overriding a truncated list.
Replaying an already committed identical request bypasses duplicate checks and returns its receipt.

## Recurring entries: automatic by default

`create_recurring_entry` requires `{description,type,amount,currency,category,interval,firstDate,
idempotencyKey}` and accepts `automatic` (default true). `interval` is `weekly`, `monthly`, or
`yearly`. `firstDate` is the first billing occurrence the user wants recorded, not an inferred
historical subscription start date. An explicitly established subscription/recurrence authorizes
ongoing recording; ask only for missing billing details and state the recurring behavior. There is no
second "should this be automatic?" question. If a one-off expense merely resembles a subscription,
ask once whether it repeats before creating a schedule. `automatic: false` remains available on request.

Example: “Tengo Netflix, 199 MXN mensuales, el día 15.” Once the first tracked date is clear, respond
“Listo, registraré 199 MXN cada día 15 hasta que me indiques un cambio.” This is permission to record
bookkeeping entries, not to move money or claim a bank charge was verified.

An hourly Worker Cron Trigger records due automatic occurrences using the America/Mexico_City
calendar. Entries have `source: "recurring"`, `paymentStatus: "unverified"`, and the scheduled
occurrence date. They count in ordinary spending/cash-flow totals. The ledger write, financial audit,
schedule advance, and schedule audit commit together. A stable occurrence key plus unique occurrence
and version constraints protect against duplicate deliveries and concurrent jobs.

`list_recurring_entries` accepts `{dueThrough?,includeInactive?,afterId?,limit?}` and returns
`{recurring:[...],nextAfterId}`. Each schedule includes `automatic`, `needsReview`, `active`, `version`,
amount, `firstDate`, `nextDate`, and timestamps. `due` compares `nextDate` to today in Mexico City.
A possible duplicate pauses the occurrence for review: `needsReview: true`, no extra ledger record,
and no date advance. The user can link the existing payment, explicitly confirm a separate payment,
or skip the occurrence. The job does not repeatedly append review receipts.

Existing schedules created before automatic recording stay manual. Old stored documents decode
`automatic` as false, and their original creation retry receipts remain valid. Enabling automatic
mode on one requires an explicit next billing date today or later; there is no bulk conversion or
silent backfill of older manual periods.

### Confirm or reconcile a payment

After the user reports actual payment/receipt, `confirm_recurring_payment` takes:

```json
{
  "recurringId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 2,
  "occurrenceDate": "2026-01-31",
  "paidDate": "2026-02-02",
  "amount": "201.50",
  "existingEntryId": "00000000-0000-4000-8000-000000000002",
  "expectedEntryVersion": 1,
  "idempotencyKey": "netflix-january-payment-confirmed"
}
```

For an already automatic entry, use its `occurrenceDate`, ID and current version, plus the schedule's
current version. Update that same entry with actual amount/date and `paymentStatus: "confirmed"`;
the schedule does not advance twice. Its original automatic source remains in the audit. A deleted
occurrence is not recreated, and a confirmed occurrence should be corrected with `update_entry`.

For an unrecorded/manual occurrence, `occurrenceDate` must equal the schedule's `nextDate`. Actual
amount/date may differ from expected values; future paid dates are rejected. It records one confirmed
entry and advances the schedule atomically. To link an existing unlinked manual payment, supply its
ID/version and matching actual amount/date, currency, and type. Full identifying facts must resolve
uniquely. Duplicate warnings still require user confirmation for a genuinely separate transaction.
Filter `list_entries` by `recurringId` to retrieve payment history.

### Pause, resume, change, or skip

`update_recurring_entry` takes `{recurringId,expectedVersion,changes,idempotencyKey}`. Changes can
contain `amount`, `description`, `category`, `automatic`, `active`, or `nextDate`. Resuming a paused
schedule or enabling automatic mode requires an explicit `nextDate` today or later. Changing
`nextDate` resets the billing-day anchor; retaining the current date preserves its existing anchor.
Changes affect future entries; previously recorded amounts remain intact.

`skip_recurring_occurrence` takes `{recurringId,expectedVersion,occurrenceDate,idempotencyKey}` and
skips exactly the listed next unrecorded occurrence, retaining an audit receipt without an expense.
For an occurrence already automatically recorded, explicitly delete that entry instead. Deletion
preserves the occurrence association and audit; the job does not recreate it or reopen the schedule.
Never skip the following month when the user meant to remove the current month's recorded charge.

`cancel_recurring_entry` takes `{recurringId,expectedVersion,idempotencyKey}` and pauses future
tracking without deleting records. This does not cancel a merchant subscription or stop bank charges.
The update tool can resume tracking with a new user-confirmed date.

Monthly recurrence preserves the original day: January 31 -> February 28 -> March 31. Yearly February
29 returns to February 29 in leap years. Weekly schedules add seven calendar days. No business-day
adjustment is inferred. A next date beyond year 9999 is rejected.

### Job authorization, limits, and recovery

The job derives owners from persisted verified Google identities and the private
`ALLOWED_GOOGLE_SUBJECTS` allowlist, then performs owner-scoped queries/writes. It fails closed without
that explicit allowlist, including in local development. Staging also requires its Google credentials.
Only active automatic schedules are eligible. OAuth logout/revocation does not cancel a saved standing
instruction; pause/cancel the schedule or remove the owner from the operational allowlist to stop it.

The job checks hourly (`0 * * * *`, UTC trigger schedule) and compares calendar dates in Mexico City.
It processes at most five occurrences per run, alternating allowed owners. Missed periods retain
scheduled dates and catch up over subsequent runs; large backlogs can take several runs. Unexpected
failure leaves the affected occurrence eligible for retry and does not prevent other owners from
being processed. Errors log only a fixed event and random correlation ID, never financial payloads.
Duplicate-blocked schedules require user resolution instead of automatic retry.

CPU headroom must be measured on the intended hosted plan before widening use. The small budget is
an operational bound, not proof that all workloads fit a free plan. The feature and Cron Trigger have
not been deployed by this change.

## Simple savings goals

`create_savings_goal` requires `{name,targetAmount,currency,idempotencyKey}` and accepts nullable
`deadline`. Saved amount starts at zero. `list_savings_goals` accepts
`{includeInactive?,afterId?,limit?}` and returns `{goals,nextAfterId}`. Goals expose `savedMinor`,
`savedAmount`, `remainingAmount`, `reached`, `version`, `active`, and timestamps. Remaining amount
bottoms out at zero; contributions may exceed the target.

`contribute_to_savings_goal` takes `{goalId,expectedVersion,direction,amount,date,idempotencyKey,note?}`.
`direction` is `deposit` or `withdraw`; amount is positive and denominated in the listed goal's immutable
currency. Contributions must be explicitly reported, not inferred from net income, and future dates
are rejected. Withdrawals cannot exceed saved funds. The balance is bounded at 9,999,999,999.99 in
its currency and uses exact cents. Allocations never create ledger income/expenses and do not verify
that money exists in a bank. Avoid assigning the same funds to several goals without user direction.

`update_savings_goal` takes `{goalId,expectedVersion,changes,idempotencyKey}`. Changes may contain
`name`, `targetAmount`, nullable `deadline`, and `active`. Archive/reactivation preserves allocated
savings; archived goals reject contributions. Correct a mistaken contribution with an audited
compensating withdrawal/deposit. There is no direct balance overwrite or destructive history deletion.

## Retry and persistence rules

Every write requires a retry key. Ledger operations (including payment confirmation/linking) share
one owner/key namespace. Goal/schedule configuration and savings allocations share a separate planning
namespace; avoid reusing keys for unrelated intents in either namespace. Before/after planning receipts
include contribution direction/date/note where applicable and remain stored with the financial audit.
Expected versions prevent lost updates; receipt and state writes commit together or roll back together.
Retries return the original receipt, even after later edits. New reads are needed for current state.

The planning tables store validated goal/schedule documents with owner/version columns and database
checks. Reads are paginated, defaulting to 25 and bounded at 100. Goals use ID order; recurring
entries use next due date/ID order and return both `nextAfterId` and `nextAfterDate`. They are suitable for
this small ledger; larger-scale query/index changes require measured demand.

## Staging rollout

Apply all pending migrations before the new Worker, including additive provenance migration
`0005_loud_spyke.sql`. It preserves financial records and existing audit JSON. Existing manual
schedule documents remain manual; there is no automatic conversion. Commit SQL with its generated
snapshot and never edit a remotely applied migration.

The root and staging Wrangler templates include an hourly Cron Trigger. Substitute your own approved
resource IDs/origin, keep the private owner allowlist configured, and deploy only after explicit
approval. No new service or paid resource is required. Refresh MCP metadata for the two new recurring
control tools and updated automatic-recording instructions. Test an automatic occurrence, duplicate
review, later payment reconciliation, pause/resume, skip, owner restrictions, and actual hosted CPU.
Existing mutation scopes are unchanged; newly created standing schedules default to automatic.

## Search, reports, budgets, preferences, history and recovery

These additional contracts are in [ledger UX](ledger-ux.md). They use existing ledger permissions.
Migration `0006_eminent_wong.sql` adds the budget/preference tables, their receipts, and the export
index without changing old financial snapshots. Budgets are explicit per-month limits, not recurring
financial writes. New tool discovery contains 30 tools; hosted new-feature trials remain pending.
