# Contributing

ContaMCP welcomes focused contributions that make the authenticated expense ledger more useful and
trustworthy. Read [AGENTS.md](AGENTS.md) and [architecture](docs/architecture.md), then follow the
[README setup](README.md#local-development). Node 24+ and pnpm 10.9.0 are required.

Discuss substantial product/schema changes in an issue before implementing them. Keep pull requests
small: describe the user-visible problem, the resulting behavior, and executed validation. Include
regression tests for behavior changes, especially money, ownership, retries and failures. Update public
tool/setup documentation with behavior changes. Never include secrets, real financial data or CFDIs.

Run `pnpm check`, `pnpm audit` and `pnpm build`. After schema edits, generate/review/commit migrations
and validate with `pnpm db:migrate:local`; after Worker config edits, run `pnpm types`. Packaging and
tests are local and require no cloud credentials. Do not deploy or provision cloud resources in a PR.

CI also scans commit history with Gitleaks and fully redacted output. Dependabot proposes weekly npm
and GitHub Actions updates; review them through the same checks without automatic merging. Updates to
the pinned Gitleaks release must also update its verified archive checksum in the workflow. Maintainers
should follow the [public release checklist](docs/open-source-release.md).

Please report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue. Code is
MIT licensed; contributions must be compatible with that license. Do not copy code from other
projects without establishing redistribution rights and retaining required notices.
