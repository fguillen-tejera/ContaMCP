# Security policy

This is an early foundation with no supported production release. Review the README's authentication
status and limitations before hosting financial data. Fixes target the current main branch.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting](https://github.com/fguillen-tejera/ContaMCP/security/advisories/new).
Include affected revision, impact, and minimal synthetic reproduction; omit credentials and real
financial records. If that option is unavailable, contact the
[repository maintainer](https://github.com/fguillen-tejera) to request a private channel. A public issue
may request a private contact without revealing vulnerability details. Do not publish an exploit or
sensitive data there.

The publishing maintainer must enable GitHub private vulnerability reporting before inviting hosted
testers. No security mailbox or response-time guarantee has been established; do not assume one.
Coordinate remediation and disclosure privately with the maintainer.
See the [public release checklist](docs/open-source-release.md) for the repository settings that must
be configured for the GitHub repository. Checked-in CI cannot enable private reporting or
GitHub push protection on its own.

## Security boundaries

- Verified OAuth identity/scopes and owner-scoped database operations protect the ledger. Shared API
  keys, client-supplied user headers and guessed expense IDs do not grant access.
- App approval is skipped only for client registrations whose return destinations all match the
  documented ChatGPT callback forms. This preapproves the recipient, not a self-reported app name
  or header. Other MCP clients require browser-bound approval. Google sign-in, client-bound PKCE,
  resource/audience validation, and ownership enforcement still apply to both paths.
- Google ID tokens are verified and discarded; only stable subject IDs are kept. MCP bearer/refresh
  tokens remain sensitive. Keep Cloudflare/Google credentials in secret storage and use least privilege.
- Audit history includes old financial values. Corrections do not erase them. Cloudflare account
  administrators can access data; this is not end-to-end encrypted storage.
- KV revocation propagation, public registration abuse, recovery, export/deletion and hosted privacy
  obligations remain operational limitations. Do not use SAT credentials or upload real CFDIs.
- Avoid request/SQL logging that contains credentials or financial contents. Review any new telemetry
  against these constraints. Tests must use synthetic data and must not bypass production auth.
