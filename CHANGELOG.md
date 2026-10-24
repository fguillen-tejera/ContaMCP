# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Weekly dependency/Actions update proposals, a checksum-pinned Gitleaks history scan, and a public
  release checklist covering repository settings and hosted validation gates.
- Literal Spanish-accent-insensitive description/amount search and exact category/month reports with
  prior-period comparison.
- Explicit monthly category budgets and persistent user-approved currency defaults, with atomic
  audit/retry receipts.
- Paginated activity history and version-checked, duplicate-reviewed restoration of deleted ledger
  entries.
- Bounded JSON/CSV entry exports and complete financial backup datasets, including original audit
  history.
- Spanish/English one-button initial app approval, with browser-remembered approvals that reconnect
  directly to Google for 30 days.
- Automatic recording by default for newly established recurring entries, with explicit automatic
  provenance, unverified status, and inclusion in recorded spending totals.
- Owner-allowlisted hourly processing with atomic occurrence/audit/schedule commits, bounded
  catch-up, duplicate review, and idempotent retries.
- Recurring pause/resume, future term changes, skipping, and in-place confirmation of automatic
  entries.
- Additive migration 0005; existing manual schedules and audit snapshots remain unchanged.

### Changed

- ChatGPT connections with exclusively registered official callback destinations go directly to
  Google, including first connections through the plugin or manual MCP setup. Other clients retain
  one-time app approval.
- Entry exports now return a maximum of 100 records per page; clients must follow `nextCursor`.
- Recurring lists use due-date/ID ordering and expose a date/ID continuation pair.
- Reuse immutable tool schemas across requests; index export pagination by owner/creation date/ID.
- Additive migration `0006_eminent_wong.sql` adds budget/preference storage and the export index.
- Organize MCP tool registration by feature and separate recurring and savings services with shared
  retry handling.

### Fixed

- Expense-only tools reject income mutation receipts on retries, preserving scope restrictions.
- Entry audit verification rejects missing/unhashed receipts and mismatched current state, with
  explicit limitations for legacy receipts and administrator changes.
- Staging read-only acceptance uses valid input and verifies the insufficient-scope challenge
  through the same assertion tested locally.

## [0.1.0] - 2026-10-24

### Added

- OAuth-protected MCP server on Cloudflare Workers: Google OIDC sign-in, audience-bound tokens,
  per-client consent, DCR, S256 PKCE, refresh and revocation.
- Expense ledger with exact integer-minor-unit money per currency, owner-scoped queries, pagination,
  export, audited corrections with hash-chained receipts, soft deletion, and idempotent retries.
- Possible-duplicate review that pauses creation for user confirmation.
- Recurring payment expectations with atomic payment confirmation/linking, and savings goals with
  exact contributions, withdrawals, progress, and archive.
- Scoped permissions: legacy `expenses:read`/`expenses:write` tools and new `ledger:read`/
  `ledger:write` financial tools.
- Local integration test suite running in workerd with real D1/KV, and a real-client MCP acceptance
  CLI under `scripts/`.
