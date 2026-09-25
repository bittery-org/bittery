# Share existing Runtime presentation with Desktop

Type: task
Status: resolved
Blocked by: 60, 63
Spec: ../desktop-extension/spec.md#shared-presentation

## Contract

Extract the existing Web Runtime Item/Vault presentation, Account-departure observation and
mutation-presentation helpers for reuse by Desktop. Keep one implementation and the current Web
behavior tests. This is presentation preparation for ticket 66; it activates no new Account owner.

## Acceptance

Web callers import the shared implementation, with no copied mapper/controller retained. Existing
Web projection/category/Account-switch/late-response tests pass, as do dependent types, ownership
graph checks and a real Web Item read/write acceptance case. The helper imports no host singleton,
storage, authentication, crypto or Sync policy. Generated Rust protocol types remain authoritative.

## Comments

2026-09-09: frontier resolved by actual Web/Desktop caller inspection. RuntimeClient and generated
projections are the shared seam; legacy UI field adaptation belongs above that seam in existing
shared client presentation code, not in Rust or native capabilities. Use existing packages rather
than create a package for one mapper. Avoid introducing a dependency cycle or retaining a generic
AccountStore compatibility facade. Routine placement can follow the actual package graph.

2026-09-09: shared extraction implemented in `@bittery/ui/runtime-presentation`; Web callers use the
shared mapper/session/departure/selection/mutation implementation. Root independent review and
simplification found no remaining blocker or useful additional wrapper. The existing package graph
remains acyclic. Targeted behavior checks passed (69 presentation/lifecycle assertions plus 25
Attachment/share/export/Move regressions), ownership graph 28/28 and dependent type checks passed.

Real Chromium cloud acceptance passed existing Login/custom-field CRUD and the complete signup,
restart/locked/password Quick Unlock, Vault/Item creation, sign-out, full sign-in, second restart
and retained-Item flow. That flow reproduced a blank email after Runtime-only sign-in; the sign-in
form now reads the selected Runtime Account display identity. The corrected test retains explicit
locked-state and identity assertions. Web acceptance used the existing built WASM, so it does not
accept concurrent ticket 67 Core changes. Full phase CI and Desktop application acceptance remain
open under their own gates.
