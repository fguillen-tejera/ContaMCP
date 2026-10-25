# Production setup and rollout

The production template supports a small **allowlisted pilot**. It does not implement public signup,
account deletion or a retention policy. Choose the production hostname and Google project/client
before provisioning or deployment. No production resource is created by CI or a build command.
Publishing this source and passing local tests do not complete the hosted gates below.

## Environment and identity

`env.production` in `wrangler.jsonc` explicitly binds a separate D1 database, OAuth KV namespace and
rate-limit namespaces (`23001` / `23002`). The IDs and account are placeholders. Never substitute
staging's IDs or copy its data, grants or credentials. Cloudflare bindings, vars and secrets must be
specified per environment; see [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).
Keep production D1 read replication disabled until consistency has its own review.

The default hostname template is `https://contamcp-production.YOUR_SUBDOMAIN.workers.dev`. Choose the
actual account subdomain before using it. For a custom domain, configure the approved domain route,
set `workers_dev: false`, and use that domain as `APP_ORIGIN`. Keep `preview_urls: false` in either
case. `APP_ORIGIN` must be one exact HTTPS origin with no credentials, path, query, fragment or
trailing slash. Alternate hosts return 421; untrusted browser origins return 403. Native/server MCP
clients can omit `Origin`; browser clients need the canonical origin.

Create a dedicated Google **Web application** OAuth client for production. Register exactly:

```text
https://YOUR_PRODUCTION_HOST/auth/google/callback
```

Configure Google branding, audience and pilot testers, requesting only the existing `openid` scope.
Google's redirect must match the deployed callback exactly; MCP client return URLs such as ChatGPT's
belong to a different OAuth flow. Follow [authentication setup](authentication.md) and
[Google's OIDC guide](https://developers.google.com/identity/openid-connect/openid-connect).
Review Google's consent/publishing requirements for the intended audience before broader access.

Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ALLOWED_GOOGLE_SUBJECTS` as production secrets.
The allowlist contains verified stable Google `sub` identifiers, never emails or guessed identities.
It is checked at sign-in and on every authenticated MCP request. Empty values do not open signup.
Removing a subject denies its existing tokens on subsequent requests; an in-flight operation may
finish. Use at most 100 distinct subjects, matching the scheduled owner-resolution bound.

Missing/blank hosted credentials or an empty subject list close authorization, callback, registration
and token endpoints with `503 production_not_configured`. Scheduled execution also fails closed for
invalid origin, missing configuration or an empty/oversized owner allowlist. `/health` only reports
process health; it does not prove migrations, Google login or operational readiness.

## Prepare configuration and isolated storage

Use Node 24 and the pinned pnpm/lockfile. Keep the public template generic. A deployment-specific
copy can live at the repository root, where relative paths remain valid:

```sh
cp wrangler.jsonc wrangler.production.local.jsonc
cp .dev.vars.example .dev.vars.production
chmod 600 .dev.vars.production
```

Both destination files are ignored. Fill production secrets privately; do not print them, include
them in shell arguments, or copy staging's secret file. Edit only the `env.production` section in the
local config: account, final HTTPS origin, approved Worker name and provisioned resource identifiers.
Keep `APP_ENV: "production"`, the explicit rate-limit bindings, privacy-safe observability settings,
and `triggers: { "crons": [] }` during preparation. An empty trigger list deliberately overrides the
root hourly job. Do not remove IDs and rely on automatic provisioning.

After the target/account and resource creation are approved, the following commands create remote
resources. Check `wrangler whoami` first and use the approved config explicitly:

```sh
pnpm exec wrangler whoami
pnpm exec wrangler d1 create contamcp-production --config wrangler.production.local.jsonc --env production --update-config false
pnpm exec wrangler kv namespace create contamcp-production-oauth --config wrangler.production.local.jsonc --env production --update-config false
```

Copy the returned IDs into the local production bindings and verify they differ from staging. Check
names/IDs again before every remote command. Never import a staging database or seed test identities
into production. Apply all committed migrations to the new empty database after approval:

```sh
pnpm exec wrangler d1 migrations list DB --config wrangler.production.local.jsonc --env production --remote
pnpm exec wrangler d1 migrations apply DB --config wrangler.production.local.jsonc --env production --remote
pnpm exec wrangler d1 migrations list DB --config wrangler.production.local.jsonc --env production --remote
pnpm exec wrangler d1 execute DB --config wrangler.production.local.jsonc --env production --remote --command 'PRAGMA foreign_key_check'
```

This change requires no new schema migration. A fresh database still needs the existing migrations.
Verify no migrations remain and no foreign-key violations are returned. Migrations and secrets are
external changes; a successful packaging dry run does not validate them.

## Gates before deployment and real financial data

Record a tested commit, time window, outcome and safe evidence for every gate. Never record payloads,
tokens, OAuth callback URLs or subject identifiers. A useful release record includes Worker version,
resource IDs, migration names, pre-change D1 bookmark, aggregate metrics and outstanding failures.
1. **Local and CI:** run frozen install, generated-type check, `pnpm check`, `pnpm audit`, local
   migration application/reapplication, and all three packaging checks (`pnpm build`,
   `pnpm build:staging`, `pnpm build:production`). Both required GitHub checks must pass for the
   reviewed revision. Dry-run the actual local production config separately:
   `pnpm exec wrangler deploy --config wrangler.production.local.jsonc --env production --dry-run --outdir dist/production-config`.
2. **Real staging identity and clients:** complete the [authenticated acceptance run](mcp-integration-testing.md)
   with two distinct allowlisted Google accounts, a read-only grant, refresh, revocation and natural
   expiry. Check consent denial, a nonallowlisted account, both intended ChatGPT connection paths,
   and phone use. Local identity fixtures do not satisfy this gate.
3. **Full financial behavior:** run the synthetic workflows in `fixtures/`, including income,
   duplicate review, budgets/preferences, savings, complete backup pagination and automatic recurring
   confirmation/reconciliation. Verify audit/retry behavior and owner isolation. The staging CLI
   covers legacy expenses and does not establish acceptance for all financial tools.
4. **Operations:** measure hosted CPU/errors/quotas on the actual plan, including OAuth and the
   scheduled job. Run a reversible synthetic staging recovery drill for ledger, audit/retry receipts
   and schedule state together. Follow [operations](operations.md); packaging/startup timings are not
   hosted CPU measurements. No paid plan or service is enabled by this runbook.
5. **Pilot policy:** review operator access, retained audit snapshots, backup protection, retention
   and account-deletion limitations. Restrict invitations to the approved pilot audience.

Do not mark unexecuted steps passed. Stop rollout for failed or inconclusive security, correctness,
CPU or recovery checks. The repository does not currently claim these hosted gates are complete.

## Deploy the reviewed revision and verify the target

After the staging gates pass and the production launch is approved, deploy from a clean checkout of
the reviewed revision with the confirmed local config. Wrangler in this project supports uploading
the ignored secret file alongside code, avoiding intermediate deployments with partial credentials:

```sh
pnpm exec wrangler deploy --config wrangler.production.local.jsonc --env production --secrets-file .dev.vars.production
```

Local secret files are not uploaded automatically. `wrangler secret put/delete/bulk` changes the
deployed Worker immediately; use the versions secret workflow for a staged later rotation. Never
print the file or pass its contents as arguments. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Keep Cron off for initial verification. Confirm production HTTPS health/discovery, advertised issuer
and resource, anonymous/forged MCP rejection, canonical-host/Origin checks and no-store/request-ID
headers. Sign in through the actual production Google client and confirm the intended scopes and
owner isolation with explicitly synthetic data before inviting users to store real data. Staging's
successful login does not validate production's callback or credentials. Preserve the synthetic audit
history; do not delete receipts directly to clean up.

After target checks pass, capture the production D1 bookmark and Worker version, then deliberately
enable `triggers: { "crons": ["0 * * * *"] }` in the approved local config and deploy the same revision.
Verify a due synthetic schedule records once for an allowlisted owner, leaves other owners untouched,
and writes its matching receipt/schedule state. The allowlist scopes scheduled work; an HTTP argument
cannot select owners. Revoking a client token does not cancel an existing standing schedule.

Record the final deployment/version IDs, trigger state and safe check results. Keep invocation logs
and tracing disabled as described in operations; query redaction and fixed application diagnostics
remain enabled. Continue monitoring aggregate CPU, errors and resource quotas after launch.

## Stop and recover

For repeated correctness/authentication failures, close access using a nonmatching allowlist sentinel
and disable the production Cron trigger through the approved deployment process. Pause manual and
automatic writes before data recovery. A code rollback does not restore D1 or OAuth KV. Use the
[recovery procedure](operations.md#recovery-procedure) with the production config and explicit
`--env production`; never run staging commands against production IDs. Restoring D1 also restores
audit/retry/schedule state and can make later retries executable again. Reconcile affected intents
before reopening access. Test this procedure on synthetic staging data before relying on it.
