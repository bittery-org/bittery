# 106 — Extension profile source and admission

Type: task
Status: needs-triage
Blocked by: 91, 73
Spec: ../desktop-extension/profile-handoff.md

## Contract

Adapt the existing Chrome Extension profile source to ticket91's shared Core admission owner after
the Desktop production acceptance gate73. Capture the existing Chrome local/session storage and
Extension IndexedDB source under the reviewed profile manifest, source identity, credential, and
accepted-work rules. Preserve the Extension's real session-instance distinction: lost session-area
state must use the reviewed typed incomplete-Session behavior and must never fabricate a complete
Session from surviving extension credentials.

Implement the closed Extension source snapshot, guarded staging/readback, reset, and scoped cleanup
primitives needed by admission. The source and destination remain owned by the existing Extension
profile; startup cannot expose a new Runtime owner until Core admission completes. Reuse ticket91's
compatibility decoder, accepted-work mapping, catalog transaction and recovery lifecycle. Do not
add a second profile journal, queue format, session owner, generic browser-storage access, or a
parallel admission policy.

## Acceptance

Use isolated fixtures built from real existing Extension records and the real serialized pending
work formats. Cover every source family and supported queue/workflow shape, exact Account and
operation identities, protected preferences/credential evidence, encrypted IndexedDB cache, and the
Extension session-instance marker. Exercise source changes, malformed or inaccessible local/session
areas, malformed IndexedDB rows, destination collisions, partial multi-Account profiles, capture and
staging write failures, lost acknowledgements, restart, explicit Abort/Wipe, and scoped cleanup. An
Extension source failure remains visibly incomplete and recoverable; it cannot fall back to old
writers or report an empty profile.

Run primitive/adapter conformance, shared Core admission regressions, generated persistence and
binding checks, targeted Extension checks, and independent review/simplification. This ticket provides
the source adapter and focused admission evidence required before offscreen composition74; it does
not replace the actual supported Chrome production upgrade, browser restart, broker reattachment, or
Worker/document-owner-loss matrix in [77](77-extension-production-acceptance.md). Do not close it
until all Extension-specific acceptance moved out of91 passes. Keep Firefox and Safari outside the
supported host claim.
