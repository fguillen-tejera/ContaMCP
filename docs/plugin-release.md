# Public plugin release

The hosted service is live at `https://contamcp.devbyfer.com/mcp`. Hosting the service,
installing a custom ChatGPT connection, and publishing in the public directory are separate steps.
This repository does not claim directory approval or publication.

## Package

`plugins/contamcp/` is the portable Agent Plugins source. It contains a versioned `plugin.json`,
one remote server in `mcp.json`, and the square ContaMCP icon. The MCP connection uses discovery
and dynamic OAuth client registration with `ledger:read ledger:write`. Google is the upstream
identity provider; its client secret and Google scopes do not belong in the plugin package.
The legacy expense-only permissions remain available in the backend but are not requested by this
listing. No skills, lifecycle hooks, local executables, app IDs or fixed bearer headers are bundled.

With Node 24, pnpm, and the standard `zip` executable installed:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:website
pnpm package:plugin
unzip -l dist/plugins/contamcp-0.1.2.zip
```

The build archives only three explicit files from `plugins/contamcp/`, rejects symlinks in those
paths, and replaces the previous archive before writing. It never recursively archives the checkout.
The ZIP has `plugin.json` and `mcp.json` at its root. Build outputs remain ignored in `dist/`.
Do not add `.dev.vars*`, `.wrangler/`, local Wrangler configuration, reviewer credentials, account
identifiers, tokens, callback URLs, production exports or private recordings to the public package.

The package is version `0.1.2`; this is a submission draft, not an approval claim. Change the version
when uploading a revised package. Update the listing fields in source rather than relying on edits
in the portal. Keep the public display name aligned with the product; resolve any naming finding
with the reviewer rather than advertising OpenAI endorsement.

## Public pages

The listing uses these public HTTPS URLs, operated by Fernando Guillen:

| Purpose  | English                            | Spanish                               |
| -------- | ---------------------------------- | ------------------------------------- |
| Homepage | `https://contamcp.web.app/en`      | `https://contamcp.web.app/es`         |
| Privacy  | `https://contamcp.web.app/privacy` | `https://contamcp.web.app/privacidad` |
| Support  | `https://contamcp.web.app/support` | `https://contamcp.web.app/soporte`    |
| Terms    | `https://contamcp.web.app/terms`   | `https://contamcp.web.app/terminos`   |

The Terms describe hosted-service behavior and preserve mandatory consumer rights. They do not
replace the source code's MIT license. Keep both languages consistent with actual authentication,
retention, exports, recurring behavior and infrastructure limits. A directory listing does not
change the best-effort service into a guaranteed financial system.

## Reviewer account and test data

Use a dedicated Firebase email/password account containing only synthetic review data. Follow
[Firebase account setup](authentication.md#firebase-email-accounts), deploy the additive identity
migration, and allow only that account's Firebase UID. Do not reuse a personal Google password or
share a maintainer's Google/ChatGPT account, production data, OAuth secret or Firebase admin access.
The demo account owns a separate ledger; matching email addresses do not link it to Google records.

Set the reviewer Login URL to `https://contamcp.devbyfer.com/login`. Reviewers start Connect in their
assistant, choose email on ContaMCP's authorization page and use the service demo credentials.
They must not need operator approval, inaccessible MFA or new account setup. Test that complete
flow in a fresh browser before submitting. The portal also offers a reviewer-email method for apps
that implement email links/codes; ContaMCP's implemented email method is password authentication,
so do not select the link/code option or claim it is supported.

Enter credentials and private sign-in instructions only in the portal's protected Review details.
Keep that account available for later reviews. Do not write credentials in this document, the
manifest, issues, PR descriptions, recordings or public chat.

The directory display name is **Conta — Income & Expenses**, in **Finance**. The repository,
package identifier and hosted service remain ContaMCP. This addresses the portal's automated
request to remove “MCP” from the display name without changing the server address.

The package supplies exactly five positive cases and three negative cases. These are planned
acceptance cases, not evidence that they have already passed. Run positives in order in the
dedicated account: create, correct, cash flow, future recurring schedule, export. They use
`2099-12-20` for the ledger and `2099-12-21` as the future schedule date so no schedule is currently
due. Keep that ledger date exclusive to cases 1-3. The expected cash flow is income `100000`,
expense `11050`, net `88950` in MXN minor units. The negative cases require no state changes.

For a new run, replace `R1` consistently with a new suffix and choose an otherwise empty date;
adjust expected filters if the date changes. Do not silently override duplicate warnings, reuse a
prior mutation key for a different intent, purge audit history or call a reset tool. Existing
synthetic review entries can be retained or soft-deleted through explicit user-authorized tools.
Pause or cancel the future schedule when the review account is retired.

## Validate and record

Before submitting, keep private dated results for each case, the source commit, package checksum,
server URL and tested client/surface. Do not copy actual credentials, authorization callback URLs,
or financial contents into public evidence.
- Connect a fresh **production** ChatGPT connection at the canonical hostname with the reviewer
  account and intended scopes. Confirm tool discovery and retrieval in a new conversation.
- Run all eight cases through ChatGPT on desktop and check the workflows on a phone. Prior staging
  phone confirmation and SDK OAuth acceptance do not prove the published production ChatGPT path.
- Record the main workflows and safe failures using synthetic data. Start after login to avoid
  recording credentials or OAuth URLs. Provide a reviewer-accessible video URL. Do not fabricate
  a recording URL or mark unfinished checks as passed.
- Check the scanned tool names, descriptions, schemas, scopes, all three boolean annotations and
  server instructions. Preserve explicit confirmation and owner/version boundaries for mutations.
- Verify discovery, authentication failures, rate limits, the four public URLs and secure HTTPS.
  Follow [production operations](production.md) and the recorded recovery procedures.

`review.demo_recording_url` is deliberately absent until a real recording is available. Test
credentials, private reviewer instructions and identity-verification details are deliberately
absent from the package. Local checks alone do not complete these gates.

## Portal submission

1. Sign in to OpenAI Platform, select the user-approved publishing organization and intended project. The current
   preference is an already verified **Fernando** organization; distinguish same-named
   organizations by their IDs and verification status before creating a draft. Confirm ownership and Apps Management Write access. Complete individual verification
   under the intended publisher name; identity documents and verification actions belong to the
   account holder.
2. Open Plugins and upload the ZIP. Select the verified publishing identity when required. Keep
   the assigned draft/plugin identity for later uploads; do not create duplicate listings.
3. Review metadata findings. Connect the single MCP server using OAuth/DCR and the declared
   ledger scopes. Never select unauthenticated access for this protected service.
4. Host the exact domain challenge as plain text at the HTTPS URL specified by the portal,
   normally `https://contamcp.devbyfer.com/.well-known/openai-apps-challenge`. Do not invent its
   value or replace a challenge used by another app. Set `OPENAI_APPS_CHALLENGE` in the private
   production config to the portal's public token. The canonical-host GET/HEAD route serves only
   a configured 32-256 character base64url token, with no JSON wrapper or newline. It returns 404
   outside production or with missing/malformed config and never reads OAuth or ledger storage.
   Do not put an OAuth credential in this variable. Deploy the reviewed source and verify the
   exact response before selecting Verify Domain. OAuth, ledger and host authorization still apply
   to their existing endpoints.
5. Complete genuine sign-in, tool scans, reviewer account details, the real recording URL, test
   evidence and release notes. Re-upload corrected metadata or rescan hosted changes as needed.
6. Once all gates pass, review the policy attestations and submit. Follow review feedback. After
   approval, explicitly publish the approved package; submission alone is not publication.

Package and website changes can be reviewed independently of OpenAI account verification. Keep
the submission draft incomplete when a real requirement is outstanding. Do not enable billing or
upgrade Cloudflare merely to create the listing.

## Official references

- [Package format and OAuth configuration](https://developers.openai.com/plugins/build/plugins)
- [Submission, review materials and publishing](https://developers.openai.com/plugins/deploy/submission)
- [MCP review requirements](https://developers.openai.com/plugins/deploy/app-review)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)

Reviewed October 25, 2026. The portal's current findings and OpenAI's current requirements take
precedence over a stale checklist.
