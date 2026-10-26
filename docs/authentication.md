# Identity and remote MCP authentication

The code implements sign-in and token verification. You supply your own Google project and Web OAuth
client: credentials and a subject allowlist are stored privately locally, and the Worker is deployed
with those values uploaded as secrets. Local tests use signed synthetic Google tokens and locally
issued OAuth tokens.

An optional Firebase email/password flow supports operator-provisioned accounts with separate
ledgers. It uses the same client-bound OAuth and scope checks; it is not a reviewer bypass.
Google-only deployments retain their existing behavior. See [Firebase email accounts](#firebase-email-accounts).

## Configure Google

1. Create/select a Google Cloud project. Configure Google Auth Platform branding, audience and consent.
   For an external app in Testing, add the intended testers. This is not an access boundary for
   basic identity scopes; a hosted deployment should also use ContaMCP's subject allowlist. Request
   only `openid`; no Drive/Gmail/payment permissions, profile or email are needed. Billing and paid
   APIs are not required by this code.
2. Create an OAuth client with type **Web application**. Add an exact authorized redirect URI:
   `https://YOUR_APPROVED_HOST/auth/google/callback`. For local testing, also register
   `http://localhost:8787/auth/google/callback`. Scheme, host, port and path must match.
3. Locally, copy `.dev.vars.example` to `.dev.vars`, then fill `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` there. Keep `APP_ORIGIN` in Wrangler equal to the browser's origin, without
   a trailing slash. Open `http://localhost:8787`, not `127.0.0.1`, with the default configuration.
4. For a hosted deployment, configure the actual HTTPS origin and use Wrangler's interactive secret
   commands after deployment. Never paste credentials into issues, chat transcripts, shell command
   arguments, or committed config.
5. Choose `GOOGLE_ACCESS_MODE` in the deployment's Wrangler vars. `allowlist` (the default, including
   when unset) requires `ALLOWED_GOOGLE_SUBJECTS` for hosted access: comma-separated stable Google
   `sub` values, checked at sign-in and every authenticated request. `public` permits any verified
   Google account without this list. Emptying the list never opens hosted access by itself. Invalid
   mode values fail closed. Local interactive OAuth keeps its existing empty-list behavior. Neither
   test identity seeding nor a bypass is included in the Worker.

Production uses an isolated Google Web OAuth client and the final HTTPS callback. Follow the
[production setup and rollout guide](production.md); staging credentials and grants are not promoted.

For public signup, use an External Google audience and publish the production project's OAuth app.
Only `openid` is requested from Google; the financial scopes belong to ContaMCP. Google's
[basic-sign-in exception](https://support.google.com/cloud/answer/15549945) also permits these scopes
without a testing-user restriction. Publishing/brand verification and managed-account restrictions
remain Google's controls. Review the actual consent screen and support/privacy information.

Google determines consent verification requirements for your application. A typical small pilot uses
billing disabled, External/Testing consent configuration, one Web OAuth client with only the Worker
callback, and designated test users. Consult [Google's current OIDC guide](https://developers.google.com/identity/openid-connect/openid-connect).

## Connect a client

For the public ContaMCP deployment, use **`https://contamcp.devbyfer.com/mcp`**. If you connected
through its previous `workers.dev` address, update the server URL and authorize again. The Google
account still resolves to the same stored user and ledger. Tokens and remembered browser approvals
are bound to the original resource/origin and are not portable between hostnames.

Use an OAuth-capable Streamable HTTP MCP client and the URL `https://YOUR_APPROVED_HOST/mcp`.
Request `ledger:read ledger:write` for the full financial workflow, or just `ledger:read` for read-only
access. Clients that also use the six legacy expense tools must additionally request
`expenses:read expenses:write` (or `expenses:read` for read-only legacy access). Each write scope requires
its matching read scope. Existing grants must reconnect to authorize additional permissions.
The service publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` and authorization-server metadata at
`/.well-known/oauth-authorization-server`. Let clients discover endpoints, including revocation.
Public dynamic registration is available at `/oauth/register` and bounded by an aggregate rate limit.
Client ID Metadata Documents are disabled: provider 1.2.4 logs client-supplied CIMD URLs outside its
error hook. DCR remains a standard supported path, including the current OpenAI host.

### ChatGPT: plugin or manually added MCP server

Both ChatGPT connection methods default to **Connect in ChatGPT → Google sign-in →
back to ChatGPT**, including when optional email accounts are configured. ChatGPT's own connection
confirmation and Google's account/consent screens still apply. Provisioned email users explicitly
select the email flow through `/login` first, as described below. ContaMCP preapproves delivery of authorization codes to ChatGPT's documented
callback addresses, after validating the OAuth request and checking its stored client registration:
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/{callback_id}`, where the opaque ID contains ASCII letters,
  digits, underscores or hyphens.

The selected callback must match a URI in the registration exactly, and **every** registered return
URI must use one of those forms. This is not a wildcard OAuth redirect registration. Alternate
schemes, hosts, ports, userinfo, query strings, fragments, extra path segments and encoded aliases do
not qualify. The parser still validates response type, S256 PKCE, requested scopes and resource
before the shortcut. Client names, homepage URLs, referrers and user-agent headers do not establish
trust. Registrations with mixed ChatGPT/non-ChatGPT destinations use ordinary app approval.

This is an explicit trust policy for ChatGPT as the authorization-code recipient, not an assertion
that a browser navigation or arbitrary network request originated from OpenAI. Google authentication,
the configured account-access policy, issuer/nonce verification, client-bound PKCE token exchange, audience checks,
and tool scope/ownership checks all remain required. The shortcut creates no browser approval cookie
and no user/ledger record before verified Google sign-in. Each attempt gets fresh Google state,
nonce, verifier and a browser-bound upstream cookie.

Keep using DCR or a pre-registered client with the exact return URI shown by ChatGPT's MCP management
page. No new secret, binding, database migration, or Google callback configuration is required. The
Google OAuth client's authorized redirect stays the Worker's `/auth/google/callback`; ChatGPT's
return URI belongs to the separate MCP authorization flow. CIMD remains disabled for the existing
provider logging/privacy reason above. Other or future callback formats safely fall back to the
ordinary approval page until reviewed. See [OpenAI's callback documentation](https://developers.openai.com/plugins/build/auth#redirect-url).

### Other MCP apps

By default, the connection screen has one **Connect with Google** action and a Cancel button. It identifies
which app is connecting, summarizes read/manage access in plain language, and shows the return host.
There are no scope checkboxes, technical permission labels, or per-feature decisions. Clicking Connect
approves exactly the validated request stored by the server and redirects immediately to Google.
Read-only clients request read-only scopes themselves; the access summary reflects that request.
The form cannot supply or expand scopes. Spanish is the default; English follows an English
Accept-Language header. Mobile viewport, keyboard focus, and nonce-bound CSS work without scripts.
Approvals are remembered for 30 days in this browser. Later requests from the same registered client,
return URI and resource go directly to Google when they request only already-approved scopes. For
these other apps, a new client, different callback, broader scope set, expired approval or invalid
cookie shows the one-button approval again. Read-only requests remain read-only even if a broader
request was approved earlier.
Clients must retain their registered client ID across reconnects; creating a new registration is a new
app identity. Clearing site cookies forgets remembered approvals.

The OAuth provider stores approvals in its bounded `__Host-oauth-approvals` cookie (Secure, HttpOnly,
SameSite=Lax). It contains no Google identity or financial records. Because identity is learned only
after Google sign-in, approvals belong to the browser, not a particular Google account; Google identity
and the configured account-access policy are still checked on every login. This cookie never supplies ledger identity
or an access token. A separate, origin-bound HMAC signing key is derived with HKDF-SHA-256 from the
existing Google client secret; no additional secret setup is needed. Rotating that secret invalidates
remembered approvals. Revoking a token does not erase browser approvals; reconnecting still requires
Google authentication. A fresh browser state, nonce and PKCE verifier protect every Google login,
including the shortcut.

The library's browser-bound secure HttpOnly cookies protect consent and upstream state. Values supplied by a client
are HTML-escaped. Google sign-in uses a separate PKCE verifier and nonce; the callback checks Google's
RSA signature, issuer, audience, expiry, issued-at, nonce, and authorized-party claim when present.
The Google subject resolves to a persisted ContaMCP user UUID. No Google token is passed to MCP clients.

ContaMCP tokens are audience-bound to the exact MCP resource, expire after 15 minutes, and can be
refreshed for up to seven days. All clients must use S256 PKCE. The library owns token hashing/encrypted props, refresh rotation and
revocation. The tools check scopes and owner ID in addition to the provider's token checks. Token
revocation uses the endpoint from discovery (the library currently shares the token URL); no custom
revocation URL is invented. Account deletion/revocation UI is not included.

The configured origin must match incoming request URLs. Unexpected hosts and browser origins are
rejected; general cross-origin browser MCP clients are not enabled by default. Native/server clients
without `Origin` can connect. If a specific host needs browser CORS, design an explicit allowlist first.

## Firebase email accounts

Email/password access is optional and disabled unless all of these values are valid:
- `FIREBASE_PROJECT_ID` in environment-specific Wrangler vars.
- `FIREBASE_WEB_API_KEY` stored privately for the same Firebase project.
- `FIREBASE_ALLOWED_UIDS`: a private comma-separated list of 1-100 Firebase UIDs, never emails.

Enable Firebase Authentication's Email/Password provider in your own project and provision the
intended accounts. No registration, password-reset endpoint, or account-linking feature is exposed
by ContaMCP. The application checks the allowed UID after verifying Firebase's signed identity;
creating another Firebase account does not grant it ledger access. Keep the deployment on its
approved plan; do not enable paid Identity Platform features or upgrade billing for this flow.

Provisioned email users first visit `/login` in the same browser, then start Connect in their
assistant. This page sets a Secure, HttpOnly, SameSite=Lax, host-only `__Host-conta-email` preference
for up to ten minutes. The next validated authorization request consumes it and shows the existing
Google/email form instead of the direct Google path. Return to `/login` before each new email
connection. Normal ChatGPT connections continue directly to Google; other clients retain remembered
Google approval. The preference is deliberately untrusted: it selects UI, carries no identity or
permissions, and cannot authorize a request. PKCE/client validation happens before it is consumed.

Google users should keep choosing Google to retain their ledger. The email form is explicitly for a
ContaMCP password, not a Google password. `/login` accepts no credentials; the password form remains
bound to a validated client authorization request. Failed-password retries keep their own fresh
browser-bound consent transaction and do not require revisiting `/login`.

The browser submits email and password only over HTTPS to `/authorize`, using the OAuth provider's
single-use, browser-bound consent handle. The Worker sends them to Firebase's fixed
`accounts:signInWithPassword` REST endpoint. It verifies the returned ID token with Google's JWKS,
RS256 signature, exact project audience and issuer, expiration, issued-at, authentication time,
password sign-in provider and matching UID. Raw Firebase tokens, email addresses and passwords are
not persisted by the Worker or passed to MCP clients. Failures use one generic message, never echo
credentials and issue a fresh consent transaction; retry pages retain the form-compatible referrer
policy. The existing aggregate OAuth rate limit bounds these requests as well.

The authorization page's `form-action` policy includes its own origin, Google, and the validated
OAuth callback origin because browsers also apply it to redirects after a form submission.
Registrations whose return URIs all match the documented ChatGPT callback policy additionally
allow `https://platform.openai.com` for OpenAI's publisher-console relay. Callback query strings,
client names and arbitrary registered alternative origins never become policy directives.
This applies to retry and cancellation pages too; PKCE, browser binding and exact registered
redirect checks still control delivery of authorization codes.

Migration `0008_spooky_flatman.sql` adds `users.auth_provider` with default `google`. Existing user
UUIDs, Google subject values, financial records and issued Google grants are retained. The legacy
`google_subject` column stores the external subject for either provider; all new identity resolution
also checks the provider. Its existing global uniqueness is retained for compatibility: a subject
collision denies login instead of merging accounts. Neither matching email addresses nor client
arguments can choose an owner. Restricted background owner resolution selects only Google identities.

New Firebase grants carry their provider and UID; legacy Google grant properties still validate.
Removing a Firebase UID from the allowlist or disabling Firebase configuration denies subsequent
MCP requests for that identity. Rotating a Firebase password alone does not revoke existing
ContaMCP tokens; revoke them separately. Existing standing recurring instructions are not canceled
by disconnecting or changing sign-in credentials.

For a reviewer, provision an independent Firebase demo account containing only synthetic records
and supply its service credentials in OpenAI's private review form. A Firebase password authenticates
that service account and does not grant access to a Google account. Keep Google account passwords,
Firebase admin credentials and OAuth client secrets out of reviewer credentials.

References: [Firebase password sign-in](https://firebase.google.com/docs/reference/rest/auth#section-sign-in-email-password),
[ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[Firebase limits](https://firebase.google.com/docs/auth/limits).

## External verification still required

- Run real Google login/consent and refresh/revoke checks over HTTPS with synthetic expenses.
- Connect the actual target ChatGPT surface and phone; verify tool discovery, corrections and
  retrieval in a new conversation. Availability/UX depends on the host and account.
- Confirm secure-cookie behavior. The library uses `__Host-` cookies; localhost HTTP handling can
  differ between browsers. An HTTPS test deployment is the definitive test.
- Validate your deployment's rate limits and host logging configuration, and review privacy notices
  before a wider pilot. KV propagation may delay revocation; do not promise immediate global
  invalidation.

Unauthenticated ledger operations always fail closed. The only test identity seeding code lives under
`test/` and is not imported by the production bundle.

## Connecting a real client

The resource metadata/challenge advertises
both read/write scopes so a discovery-driven client can request mutations. The connection grants exactly
the requested scopes, and tool handlers enforce the actual scope. Read-only mutation errors include a standard
MCP insufficient-scope challenge. Google tokens with multiple audiences also require the correct
authorized-party claim. OAuth errors use safe codes and fixed diagnostics rather than raw descriptions.

## New financial permissions (local implementation)

Income, recurring entries, savings goals, reports, budgets, preferences, history and complete backups require `ledger:read` / `ledger:write` consent.
Existing `expenses:read` / `expenses:write` tokens retain only legacy expense access. New mutations
require both ledger scopes; read-only ledger grants cannot write. Consent and OAuth discovery describe
all four scopes. Refreshing tool metadata does not expand a token: reconnect to authorize the new
permissions. See [financial workflows](financial-workflows.md). Hosted sign-in with these new scopes
has not been tested yet.

## Remote acceptance

[mcp-integration-testing.md](mcp-integration-testing.md) describes a real-client acceptance run
against a deployed Worker with two distinct allowlisted Google accounts.

## Standing recurring instructions

New user-established schedules default to automatic recording. Ledger write consent describes
management of automatic recurring records; the creation result and tool instructions make the
standing behavior explicit. Existing manual schedules are preserved. The internal Cron handler
uses the private verified-subject allowlist in restricted mode. In public mode it selects persisted
owners of up to five eligible due schedules, ordered by scheduled date and ID, rather than scanning
every registered user. Every read and mutation remains owner-scoped; an HTTP argument or header
cannot choose an owner. Revoking a client token does not cancel a standing schedule. Pause/cancel it
to stop future automatic recording. Removing a subject from the operational allowlist also stops it
in restricted mode, but has no effect in public mode.
