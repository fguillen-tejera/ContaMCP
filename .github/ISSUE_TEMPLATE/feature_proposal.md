---

name: Feature proposal
about: Propose a change to tools, schemas, or behavior
labels: enhancement
---

**Problem**
What user-visible limitation does this address?

**Proposed behavior**
How should the tool or endpoint behave? Include example inputs/outputs where relevant.

**Constraints to respect**
- Money in integer minor units, exact arithmetic, explicit currency.
- Owner-scoped access; no user IDs in tool arguments.
- Idempotency keys on all mutations; audit history preserved.
- No new secrets, paid services, or third-party data flows without discussion.

**Alternatives considered**
