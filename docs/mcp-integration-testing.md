# Authenticated remote MCP acceptance

The scripted acceptance client verifies its required expense tools without assuming a fixed total tool count. The scripted acceptance assertions exercise the legacy expense
workflow with its original expense scopes; passing them does not validate the new income, recurrence,
or savings tools. After a financial rollout, reconnect with ledger scopes and run the
[new synthetic workflows](../fixtures/financial-workflows.es.json) with a real agent. These fixtures
are expectations only; local runtime coverage is provided by `pnpm test`.

Run only against your own deployed Worker, with a dedicated staging database and synthetic data.
The checked-in client uses the separately installed MCP client SDK, real HTTP, OAuth discovery, DCR,
S256 PKCE, an ephemeral IPv4 loopback callback, callback state/issuer verification, in-memory discovery
binding across the redirect, and browser Google
sign-in. It imports no server authentication helper and has no way to seed or bypass identity.
No model/API key, chatbot, frontend or Inspector installation is necessary.

## Run

Complete a hosted deployment with two distinct allowlisted Google accounts (see
[authentication](authentication.md)). Then run on your
computer (Node 24, default browser available, terminal not recording secrets):

```sh
pnpm install --frozen-lockfile
pnpm test:mcp:staging https://contamcp-staging.YOUR_SUBDOMAIN.workers.dev/mcp
```

The browser opens for A, then **a different B**, then A with read-only consent. Check the account shown
by Google each time; `prompt=select_account` is intentional. The CLI uses a loopback return address, so use Connect with Google for its new registration; there are no individual permission choices.
A remembered registration may go directly to Google for 30 days in the same browser.
For the read-only login, the client requests only read access and the summary reflects that. An account mismatch causes acceptance failure.
Each login has a five-minute timeout. Tokens/verifiers/client information stay in process memory and
are lost on exit; they are never printed or persisted. HTTP diagnostics print only status and a validated
server-generated request ID. Failed SDK responses/URLs are not dumped. Read the last printed phase and
safe Worker diagnostics if login fails. Close Google/consent tabs afterward; browser history belongs to
that browser and is outside the CLI's in-memory storage guarantee.

For the complete credential-expiry acceptance run:

```sh
pnpm test:mcp:staging https://contamcp-staging.YOUR_SUBDOMAIN.workers.dev/mcp --wait-for-expiry
```

This waits until account A's original 15-minute token expires, sends it without an automatic refresh,
requires HTTP 401, then refreshes and proves the new credential works. The shorter run explicitly marks
natural expiry **NOT RUN**; it does not claim complete remote acceptance. Expired KV token records are
also tested locally without a fifteen-minute delay, independently of any client-side expiry behavior.

## Assertions and effects

- Anonymous requests return 401 with protected-resource discovery; forged bearer/user-ID headers fail.
- All thirty tools are discovered. A concurrent retry of `create_expense` returns one expense ID.
- A fresh A connection retrieves the persisted record, including pagination if necessary.
- B creates with the same retry key but receives a distinct record; B cannot update A's ID or list it.
- A updates 0.10 MXN to 0.30 MXN, then repeats the identical correction. Version stays 2.
- Baseline-relative exact totals/counts increase only by A's 0.30 and B's 0.10; no duplicate retries.
- Changed input with an old retry key, invalid amount, and stale expectedVersion are rejected.
- A read-only grant cannot create a schema-valid expense; it receives `FORBIDDEN` and an
  insufficient-scope challenge. The same assertion runs in the local runtime suite, including a
  check that it fails against a writable grant.
- A fresh token works after refresh. Revocation is accepted, then observed with bounded retries.

Each successful run leaves two synthetic expenses and three audit receipts. The filter date is
`2099-12-30`, category `travel`, currency MXN, description `SYNTHETIC ContaMCP staging test`. Future dating
is deliberate and explicitly supplied. Summary baselines allow repeated runs, but stop other writes to
that test range while running. Partial failures may leave fewer records: retries after an uncertain
mutation must use the same key/input, and a new CLI run creates a new test intent. Never delete just
audit receipts to clean up. Keep records for review or reset the whole disposable staging environment
deliberately. Cleanup is an explicit audited deletion operation; never remove audit receipts separately.

The script exits nonzero on assertion/transport failure. It performs at most two retries of HTTP 429,
respecting `Retry-After` up to 60 seconds, reusing the same request. KV has eventual consistency and a
per-key write limit: immediate token exchange/refresh may receive retryable 429. Do not hammer login.
Revocation is observed for up to roughly 90 seconds; failure in that window is recorded as inconclusive/
failing acceptance, not proof of instant global revocation. A 503 `staging_not_configured` means the
secrets/allowlist are incomplete; 403 `invalid_identity` means the subject is not allowed; Google
`redirect_uri_mismatch` means its exact callback registration differs. For 1102 inspect CPU metrics.

## Manual checks beyond the scripted run

1. With the CLI or another non-ChatGPT client in a private browser, deny ContaMCP consent; no Google
   login or expense should occur. Restart from the client after denial. Repeat with a third,
   nonallowlisted Google account: no MCP grant or ledger
   access should result. Clear the account's tokens/client session between trials.
2. Confirm consent/Google callbacks have Secure, HttpOnly, host-only cookies; missing/altered browser
   state and replayed callback fail. The local suite covers malicious redirect, bad PKCE, bad Google
   audience/issuer/nonce/authorized-party/signature/expiry and state replay without touching real users.
3. During a dedicated quiet test, request the OAuth endpoints more than 20 times in one minute or MCP
   more than 120 times in one minute from the same location. Observe any 429 with `Retry-After`, then
   recovery after the window. These are eventually consistent regional counters, so a bounded burst
   may overshoot without producing 429. Record that outcome as inconclusive, not a pass. Do not run a
   load test.
4. Check migration state, audit count and referential integrity using the nonfinancial queries in
   [operations](operations.md). Three receipts are expected per complete run, with one version-1
   receipt per created expense and one version-2 correction for A.
5. Test retrieval in the actual target MCP host and phone separately. The CLI proves connection
   independence, not an untested host's UX or availability.

## Local regression validation

`pnpm check` runs the same scenario assertions in workerd through independent client connections with
locally issued OAuth tokens; it also verifies the suite rejects using A for both accounts. These tests
inject HTTP dispatch and synthetic Google responses. They are useful regression tests, not the real
network/Google trial. No remote run is performed by CI.

The independent client follows the [MCP authorization contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
Use the pinned package/lockfile instead of a floating Inspector version when recording repeatable results.

## Bounded operational probes

During an approved quiet staging window, run separately from acceptance and agent writes:

```sh
pnpm test:mcp:staging https://contamcp-staging.YOUR_SUBDOMAIN.workers.dev/mcp --probes
```

This uses one real Google login and retains credentials only in memory. It creates one synthetic
expense on `2099-12-29` (`other`, MXN), runs 16 calls each for discovery, listing, summary, creation
replay and correction/replay, then waits 65 seconds. It sends at most 300 sequential anonymous MCP
requests, with 100 ms pauses, stopping at the first 429. Two valid authenticated mutation attempts
must then return 429 with retry guidance. After another 65 seconds, reads/discovery must recover.
Unlike acceptance, these probe requests do not automatically retry 429. A missing 429 or unexpected
status fails the run; do not expand traffic indefinitely.

Read remote nonfinancial D1 expense/audit counts before and after: a successful isolated run adds
exactly one expense and two audit receipts. This independent check is required to establish rejected
mutations did not persist. The CLI prints only operation labels, timestamps, status and request IDs;
it does not report network latency as CPU. Collect Cloudflare CPU metrics separately. Independent
hosted per-user throttling is not proven when the aggregate ingress limiter fires first.

## Remembered app approval

A new non-ChatGPT app registration must show the single Connect with Google screen. After approving,
reconnect using the same registered client and browser: it should go straight to Google, still requiring the
usual account selection and identity verification. A new registration, callback change, permission
increase, cleared cookies or expired approval should show the initial approval again. The acceptance
CLI keeps client metadata only in process memory, so a new CLI process registers a new client and
correctly asks again. Local runtime tests cover cookie signatures, expiration, credential rotation,
client/callback binding, scope narrowing and fresh login state; hosted browser checks remain pending.

## Direct ChatGPT connection

Test both the installed ContaMCP plugin and a manually added ContaMCP MCP URL in ChatGPT, using
DCR and the exact callback shown in ChatGPT's management page. When every registered callback is a
supported ChatGPT destination, a first connection in a fresh browser should go immediately to Google
without a ContaMCP approval page. Complete account selection and verify a persisted synthetic entry
from the intended account; changing the Google account must still select that account's own ledger.
No token should be issued when Google authentication or the subject allowlist rejects the account.

Both stable and connection-specific ChatGPT callback formats are covered by local runtime tests,
including Google JWT verification, code/token exchange, authorized tool writes, and callback replay
rejection. Negative tests cover unregistered/mixed callbacks, spoofed names/headers, lookalike URLs,
wrong resources, invalid PKCE/scopes, missing browser binding and disallowed Google subjects. Local
tests use synthetic Google responses; the real hosted ChatGPT/Google path has not been tested here.
See the [recipient trust policy](authentication.md#chatgpt-plugin-or-manually-added-mcp-server).
