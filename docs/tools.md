# MCP tool contract

Only the authenticated user's ledger is accessible. All tool inputs are strict objects; unknown
fields, including user IDs, fail validation. Successes include machine-readable `structuredContent`
and a JSON text representation. Errors have `isError: true` and structured `{error:{code,message}}`
for application failures; SDK schema failures also return MCP tool errors describing invalid input.
No SQL, token or financial record is included in internal error messages.

The new income, duplicate-review, recurrence, and savings tools are documented in
[financial workflows](financial-workflows.md). See [search, reports, history, budgets, preferences, and bounded exports](ledger-ux.md) for the additional contracts.
This page describes the six legacy expense tools.
Legacy tools retain expense-only scope and filtering.

## Create

```json
{
  "description": "Gasolina",
  "amount": "450.00",
  "currency": "MXN",
  "date": "2026-10-23",
  "category": "transport",
  "idempotencyKey": "example-create-01"
}
```

Call `create_expense`. `date` is optional; other fields are required. `amount` is a
positive decimal string with up to two fractional places and ten integer digits. No signs,
scientific notation, leading zeros, thousands separators, symbols or rounding. Supported currency
codes are `MXN`, `USD`, `EUR`. Descriptions are trimmed, nonempty, at most 500 characters.
Dates are real `YYYY-MM-DD` calendar dates from 1900 through 9999. An omitted date means today in
Mexico City. Category is required: infer the closest category when confident, ask the user when torn
between two, and use `other` only when nothing fits. An agent must clarify an unknown currency or amount.

Keys are 8–128 ASCII letters/digits/underscores/hyphens. Reuse only when retrying identical tool input.
A changed payload or different mutation tool with an existing key produces `IDEMPOTENCY_CONFLICT`.
New keys express new intents. Similar existing records trigger `POSSIBLE_DUPLICATE` without writing;
see the user-confirmed duplicate acknowledgement flow in [financial workflows](financial-workflows.md).

Success: `{ "expense": { "id": "UUID", "description": "Gasolina", "amount": "450.00",
"amountMinor": "45000", "currency": "MXN", "date": "2026-10-23", "category": "transport",
"version": 1, "createdAt": "UTC ISO timestamp", "updatedAt": "UTC ISO timestamp" } }`.
Entries also return `source` and `paymentStatus`. Money output fields are strings. The stable UUID identifies the record across conversations.

## List and summary

`list_expenses` accepts `{from?,to?,category?,currency?,paymentStatus?,query?,minAmount?,maxAmount?,deleted?,limit?,cursor?}`. Both dates are inclusive;
`from` must be no later than `to`. `limit` is an integer from 1 to 100, default 25. Return:
`{expenses:[...],nextCursor:string|null}`. Keep the same filters with each cursor. Sort is date
descending, then ID descending. An empty list is a successful query without matching records.

`get_expense_summary` accepts `{from?,to?,category?,currency?}` and returns
`{totals:[{currency:"MXN",amount:"450.00",amountMinor:"45000",count:1}]}`.
Automatic recurring charges count in totals; `unverifiedCount` identifies those awaiting user
confirmation. The optional `paymentStatus` filter supports confirmed-only queries.
No matches returns `totals:[]`. Multiple currencies are separate entries, never a combined total.
Amounts come from persisted records, not agent arithmetic or conversation memory.

Categories: `food_drink`, `groceries`, `transport`, `shopping`, `entertainment`, `education`,
`bills_services`, `health`, `home`, `pets`, `travel`, `other`. Every expense has exactly one; the
agent asks rather than guessing when unsure. No automated categorization or tax claim.

## Update

Call `update_expense` after identifying the exact target with `list_expenses`:

```json
{
  "expenseId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "idempotencyKey": "example-update-01",
  "match": { "description": "Gasolina", "date": "2026-10-23" },
  "changes": { "amount": "405.00" }
}
```

`match` must contain identifying facts explicitly supplied or confirmed by the user. Multiple
matching records produce `AMBIGUOUS_TARGET`, even with a valid ID/version. Never copy arbitrary
candidate facts to turn ambiguity into an apparently unique match.

`changes` requires at least one of description, amount, currency, date, category. Omitted fields stay
unchanged. Currency changes re-denominate the entered amount and
do not perform conversion. Confirm intent before changing currency. Return the complete updated
expense and incremented version. Retrying the original request/key returns the original correction
receipt, even after subsequent edits; list again when the current record is needed.

`NOT_FOUND` covers missing and other-user IDs identically. `CONFLICT` means the version changed;
list again and ask whether the correction still applies. `ALREADY_DELETED` means the record was
soft-deleted; it no longer appears in lists or totals. `INVALID_INPUT` includes invalid cursors.
`FORBIDDEN` means the token lacks the tool's scope. `INTERNAL_ERROR` indicates an unsuccessful or
uncertain operation: retry a mutation with its original key and identical input, never a fresh key.

## Delete

Call `delete_expense` only on an explicit user request, after identifying the exact target with
`list_expenses`:

```json
{
  "expenseId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "idempotencyKey": "gasolina-20261023-delete-1",
  "match": { "description": "Gasolina" }
}
```

Deletion is soft: the record leaves lists and totals but its audit history is preserved, and explicit `restore_entry` with ledger permissions can append an audited restoration. The same ambiguity discipline as corrections applies — the server rejects multiple
matching records and requires the current `expectedVersion`. Prefer a correction over deletion when
the user reports a wrong amount; delete only when the user truly wants the record gone. Retrying the
original request/key returns the original deletion receipt.

Read tools advertise read-only/idempotent/closed-world annotations. All mutation tools require
`expenses:write` and advertise idempotency. Update and delete are marked destructive because they
change an existing record, even though the original is preserved in audit history. Creation is
non-destructive. Annotations guide clients; they are not authorization enforcement or a substitute
for user intent.

## Paged legacy export

`export_expenses` accepts `{limit?,cursor?,format?}`. The default/maximum page is 100 and includes
deleted expenses. JSON returns `expenses`; CSV returns `csv`. `count` is the page count and
`nextCursor` must be followed until null. This replaces the previous unbounded export contract.
See [export details and full financial backups](ledger-ux.md#bounded-exports-and-complete-backups).
