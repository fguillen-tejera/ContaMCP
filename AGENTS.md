# Engineering standards

- Write simple, idiomatic, focused TypeScript with strict types. Avoid `any`, circular imports, unused code/dependencies, boilerplate, and speculative abstractions. Follow existing conventions.
- Prefer descriptive names. Comment only on reasons, constraints, and invariants; do not narrate straightforward code. Keep long explanations in `docs/`.
- Keep domain rules independent of MCP, HTTP, and database adapters. Separate authentication, business logic, and persistence with explicit dependencies; keep architecture proportional to the ledger.
- Treat HTTP and MCP inputs as untrusted; validate boundaries. Identity comes only from verified authentication, never tool arguments or user-ID headers. Authorize and scope every database operation to its owner; deny by default and use least privilege.
- Never log secrets, credentials, tokens, or financial contents. Never commit secrets, production data, or real CFDIs. Use synthetic fixtures only.
- Use integer minor units and exact arithmetic for money. Specify currency, calendar dates, and timezone explicitly. Preserve mutation audit history and retry idempotency. Never invent records or guess ambiguous values.
- Test meaningful behavior and regressions, prioritizing money, authorization, idempotency, and failures. Run relevant tests, type checking, linting, and formatting checks before completion. Only report executed checks as passed.
- Keep APIs understandable, dependencies justified, documentation current, and changes focused/reviewable. Never return fake success for incomplete work.

## Structure

`src/domain/`: validation and money; `src/expenses/`: ledger application service;
`src/db/`: Drizzle schema and D1 persistence; `src/auth/`: Google/OAuth;
`src/mcp/`: tool/transport adapter; `src/index.ts`: Worker composition.
`migrations/`: versioned Drizzle SQL; `test/`: runtime integration tests;
`fixtures/`: synthetic Spanish agent workflows; `docs/`: architecture and setup.

## Commands and completion

Use Node 24 and pnpm. `pnpm install`, `pnpm db:migrate:local`, `pnpm dev`.
`pnpm db:generate` generates migrations; `pnpm types` generates Worker bindings.
`pnpm check` runs formatting, lint, type checking, and tests. `pnpm build` packages a deployment dry run locally.
A change is complete when behavior is implemented, meaningful tests and checks pass,
security/financial boundaries are reviewed, and setup/API documentation is current.
Do not deploy, provision remote resources, or enable paid services without explicit approval.
