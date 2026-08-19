# Specification authoring rules

## Evidence statuses

Current-state claims use exactly one status:

- **Observed** — proven by an executable test or production implementation.
- **Documented** — stated in accepted documentation but not fully verified in code.
- **Inconsistent** — relevant sources disagree.
- **Partial** — implemented only for some flows or platforms.
- **Unreachable** — implementation exists but no supported product path reaches it.
- **Proposed** — present only in a plan or proposed decision.
- **Defect** — implemented behavior contradicts an invariant or intended outcome.
- **Unknown** — deliberately unresolved after investigation.

Use the strongest available evidence in this order:

1. Executable behavior test.
2. Production implementation, naming the path and symbol.
3. Generated contract or persisted fixture.
4. Accepted ADR or security document.
5. Product or UI documentation.
6. Unverified observation.

Documentation alone does not make a claim Observed. Contradictions stay visible.

## Requirements

Every target requirement receives a stable identifier such as `SYNC-OFFLINE-004`. Identifiers name
enduring behavior, not a file or implementation module.

- **MUST** — release-blocking.
- **SHOULD** — expected unless an accepted exception says otherwise.
- **MAY** — supported design freedom.
- **OUT** — explicitly outside the named release.
- **OPEN** — unresolved and unavailable for implementation.

## Decision lifecycle

- **Candidate** — outcome of a grilling or research session.
- **Accepted** — explicitly approved after consistency review.
- **Superseded** — replaced by a linked decision.
- **Deferred** — intentionally unresolved for the current release.

Use an ADR only when a decision is hard to reverse, surprising without context, and the result of a
real trade-off. Product preferences and ordinary implementation choices do not become ADRs.

## Agent authority

When specifications are incomplete or contradictory, an implementation agent:

1. Continues unrelated work.
2. Opens a structured specification issue with evidence, affected requirement IDs, and alternatives.
3. Adds a failing test only when the expected behavior is already unambiguous.
4. Leaves persisted-format and security behavior unresolved until accepted.
5. Preserves every `MUST`; making a test pass is not authority to weaken it.

## Current and target separation

The frozen product is not a compatibility constraint. Every current capability receives exactly one
disposition:

- **Keep** — same user-visible semantics.
- **Simplify** — same outcome with reduced behavior.
- **Replace** — same need with different semantics.
- **Remove** — intentionally absent from the long-term product.
- **Defer** — part of the long-term target but outside the first release.
- **Investigate** — evidence or value remains unresolved.

