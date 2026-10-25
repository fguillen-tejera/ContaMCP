# Public release checklist

ContaMCP is an experimental self-hosted project. Publishing source does not establish readiness for
real financial data. Keep the README's hosted-validation limitations visible in releases.

## Repository publication

- Review the files staged for the first commit. Local secrets, `.wrangler/`, build output, internal
  briefs, real financial records and CFDIs must stay out of the repository. Use synthetic fixtures.
- Run `pnpm install --frozen-lockfile`, `pnpm exec wrangler types --check`, `pnpm check`, `pnpm audit`,
  `pnpm build`, `pnpm build:staging`, and `pnpm build:production` with Node 24. Apply and reapply migrations to a disposable
  local database with `pnpm exec wrangler d1 migrations apply contamcp --local --persist-to /YOUR/TEMP/DIRECTORY`.
  Never use a remote binding for these checks.
- Review the MIT license, contributor documentation, tool contracts and changelog. The canonical
  repository is [fguillen-tejera/ContaMCP](https://github.com/fguillen-tejera/ContaMCP); update package,
  setup and security-reporting links when publishing a fork.
- Confirm both `validate` and `secrets` CI jobs pass after pushing. The Gitleaks CLI is pinned and its
  release archive is checksum-verified; findings are fully redacted. It scans fetched commit history,
  so uncommitted local files still require review before publication.
- Enable GitHub private vulnerability reporting and verify that **Security → Advisories → Report a
  vulnerability** is available. Add the actual reporting-page link to `SECURITY.md`.
- Enable GitHub secret scanning and push protection where available, and require both CI jobs before
  merging changes to the default branch. Confirm Dependabot can open npm and GitHub Actions updates.
  These repository settings cannot be activated by adding workflow/configuration files alone.

Gitleaks installation/CLI documentation is maintained by [the upstream project](https://github.com/gitleaks/gitleaks).
Dependency-update settings follow [GitHub's Dependabot documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
No cloud resources, paid services, publishing or deployment are performed by these checks.

## Hosted financial-data gates

- Validate real Google sign-in and both target MCP connection paths over HTTPS, including scopes,
  refresh/revocation, consent rejection, cross-owner isolation and phone use.
- Run synthetic income, duplicate review, automatic recurring recording/reconciliation, budget,
  savings and backup workflows. The scripted staging acceptance run covers the legacy expense path;
  it does not establish full financial-feature acceptance.
- Measure hosted CPU and quota headroom with the actual configured environment and allowlist.
- Complete a synthetic recovery drill covering ledger state, audit/retry receipts and recurring
  schedule state. Keep manual and automatic writes paused during a consistent financial backup.
- Review retention/account-deletion limitations and operator privacy responsibilities before inviting
  users to store real financial contents.

Record the tested revision and results. Follow [operations](operations.md) and obtain explicit approval
before remote provisioning, migrations, secret changes, deployment or paid-service activation.
Use the [production runbook](production.md) to record the launch decision and environment-specific checks.
