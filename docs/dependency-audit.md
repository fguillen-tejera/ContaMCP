# Temporary dependency-audit exception

Maintainer-approved on November 17, 2026. Reevaluate by **November 24, 2026**, and remove
the exception as soon as a patched version is available.

`pnpm.auditConfig.ignoreGhsas` contains only
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), a regular-expression
denial-of-service issue in picomatch 4.0.7. The registry and advisory offered no patched release
when this exception was approved.

The installed dependency is used by development/test/build tooling. Before adding this exception,
`pnpm audit --prod` reported no known vulnerabilities after the Hono 4.13.16 security update.
Production request handlers do not accept glob patterns or call picomatch. The vulnerable
development dependency remains installed: the exception accepts that residual tooling risk; it
does not patch the package.

The full `pnpm audit` command remains in CI. All other advisories still fail the audit. This one
advisory is suppressed wherever it appears, so reconsider the exception immediately if picomatch
enters production dependencies or tooling starts accepting untrusted patterns. Check dependency
paths and the advisory again when reviewing the exception; do not treat an ignored audit result
as proof that the package is fixed.
