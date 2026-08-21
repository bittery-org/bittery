# Bittery greenfield specification

This directory is the authority for specifying the clean-reset Bittery rebuild. It separates
facts about the existing product from candidate decisions and accepted target requirements.

The current product is frozen for this work at:

- Commit: `f021c85e1d3a9d3f3418ba67a9ff04f319987903`
- Commit date: 2026-08-19
- Commit subject: `feat(mobile-tauri): replace credential state with native vault`

Once implementation of the rebuild begins, the existing Bittery product will receive no further
changes. The greenfield system has no data, ciphertext, protocol, or account-compatibility
obligation to this snapshot.

## Status

This corpus is **pre-implementation**. Decisions recorded from grilling are `Candidate` until the
consistency review accepts them. No agent may implement an `OPEN` topic by inference.

| Area | Status | Authority |
| --- | --- | --- |
| Authoring and evidence rules | Candidate | [AUTHORING.md](AUTHORING.md) |
| Existing product baseline | Catalog pass 1 | [current-state/README.md](current-state/README.md) |
| Product target | Candidate | [target/product.md](target/product.md) |
| Architecture target | Candidate | [target/architecture.md](target/architecture.md) |
| Cryptographic format `0x01` | Accepted | [target/cryptographic-format.md](target/cryptographic-format.md) |
| Candidate decisions | Candidate | [decisions/0001-foundation-candidates.md](decisions/0001-foundation-candidates.md) |
| Feature dispositions | In progress | [feature-disposition.md](feature-disposition.md) |
| Acceptance scenarios | Format defined | [scenarios/README.md](scenarios/README.md) |
| Traceability | Format defined | [traceability.md](traceability.md) |
| Unresolved questions | Open | [open-questions.md](open-questions.md) |

## Document roles

- `current-state/` records what the frozen Bittery implementation demonstrably does. It is evidence,
  not a target requirement.
- `target/` contains normative requirements after acceptance.
- `decisions/` records consequential trade-offs and their status. Candidate decisions are not ADRs.
- `scenarios/` specifies behavior in a form that can become shared conformance fixtures.
- `grilling/` defines bounded future grilling sessions and their handoff discipline.
- `feature-disposition.md` accounts for every current capability as Keep, Simplify, Replace, Remove,
  Defer, or Investigate.
- `traceability.md` links evidence, target requirements, decisions, scenarios, and tests.

## Implementation gate

Implementation may begin only when:

1. Every current capability has a disposition.
2. Every security-critical scenario is resolved.
3. Persisted and public formats are specified and versioned.
4. Every platform responsibility is assigned.
5. Every open question is answered or explicitly deferred outside the release.
6. Every `MUST` requirement has a traceable acceptance scenario.
7. Candidate decisions have passed a consistency review and are Accepted or Deferred.
