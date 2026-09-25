# Keep credential keys private across shared Item commands

Type: task
Status: resolved
Blocked by: 69, 71, 80, 89
Spec: ../desktop-extension/passkeys.md#shared-prerequisite-before-desktop-cutover

## Contract

Keep the existing private Login/passkey payload inside Core while ordinary projections expose only
public credential metadata. Generate distinct ordinary editable drafts and explicit private Import/
Export transfers. Ordinary edits merge current private fields under the existing Item/version and
Account guards; no host draft can insert, replace or accidentally erase a private credential.

Preserve exact credential removal and Desktop's same-Vault Duplicate through semantic Core commands
using existing Item Update/Create acceptance. Duplication may read an eligible existing local overlay
without inventing confirmed authority. Keep all supported Item fields, categories, private credential
bytes and `.bttrx` round-trips; Share continues to exclude passkeys. Reuse ticket71's scoped Export
lifetime and current formatter/Attachment delivery, with no ordinary private projection escape hatch.

This capability precedes Desktop activation and has no dependency on Extension placement or ticket75.
It introduces no counter floor, passkey ceremony, credential database or new scheduling owner.
Ticket75 later extends this same explicit Export owner with its local counter evidence.

Reviewed97 also reuses this internal private Item read/format owner for the temporary legacy native
source. That closed authenticated-peer encoding is not an ordinary projection, renderer request or
private-field flag; it adds no dependency from95 to97 and is removed at Extension cutover76.

## Acceptance

Start with a real stored ES256 credential and ordinary Login edit: generated projections contain no
private key, while the resulting encrypted Item retains the same credential and can still sign.
Reject injected private fields, stale guards, replaced credentials, conflicting pending work and
wrong Account/Vault identities. Preserve concurrent current private metadata and sibling credentials.

Then exercise exact removal, Desktop Duplicate including readable local evidence, all five ordinary
Item categories, explicit private Import and `.bttrx` Export/Import, and Share exclusion. Keep the
actual Web edit/export paths green when shared types change. Test lock, hidden-Vault retirement,
caller/owner loss and final archive delivery through the existing scoped capability. Compilation or
matching JSON shapes alone does not prove key preservation or application acceptance.

Migrate shared/Web consumers with this capability; Desktop consumes it in66/72 and verifies actual
gestures in73. Extension consumes it in75/76 after Desktop acceptance. Remove transitional callers
only after the repository graph proves their final application caller migrated. Run generated
contracts, crypto vectors, targeted Core/SQLite/IndexedDB/browser checks, dependent types and both
full CI commands before phase completion.

## Comments

2026-09-23 resolved after independent Spec/Standards review, real credential and browser
acceptance, and both literal full CI commands on the frozen joined95/105 code snapshot
`a27b1f9643aef96f0c0c6983f586693252fb0c17`. Application CI passed as recorded below.
`GIT_INDEX_FILE=/tmp/bittery-runtime-orchestration.7hGO37/phase-ci-index CARGO_BUILD_JOBS=2 pnpm check:ci:rust`
also exits0. Its full log `/tmp/bittery-runtime-95-105-full-ci-rust-retry2.log` has SHA-256
`a6ccbbd46e5bb17d0b63305f291e100351e61510f81063c79af21ab08f8535a6`: Server checks, crypto
vectors/tests, 1,406 Core tests, all integration targets including133 profile-admission tests,
67 generator tests, fresh generated contracts and native/Web bindings, and Desktop checks pass.
Web binding tests pass11 with one expected skip; Desktop default tests pass205 library cases
with25 opt-in cases ignored and60 native-host cases. The six newly reviewed physical cuts
remain isolated and are not included in those default counts. Final frozen-source audit found
only planning changes since the reviewed code snapshot. The phase freeze is released and97's
last dependency is complete. Desktop/Extension activation and their platform acceptance remain
their own tickets; this closure does not waive them.

2026-09-23 the joined95/105 literal `CARGO_BUILD_JOBS=2 pnpm check:ci` passes: all 15 type-check
tasks, all 14 package test tasks, 27 script tests and 63 actual Chromium cases across 12 separately
run suites. Evidence: `/tmp/bittery-runtime-95-105-full-ci-retry2.log`, SHA-256
`2092bafa7d49f6d8aaf11640ee345bb2acfc674872233cccc6aeb60551734ef9`.
Main production/tests remain frozen at the reviewed integration snapshot
`a27b1f9643aef96f0c0c6983f586693252fb0c17`; subsequent changes are planning only.
The corrected literal Rust gate is running. Earlier passing segments do not substitute for
that full run, so this checkpoint does not yet resolve either ticket.

2026-09-23 joined integration review preserves the remaining legacy Desktop move callers until
their Runtime cutover: a private typed draft helper retains passkeys and password history while
removing Item/Account/version metadata. Its reproducing test fails against the old caller and
passes with the helper (1/1, eight assertions); dependent types and independent Spec/Standards
review pass. Full CI also exposed stale test selections after the new Core-issued guards:
held-operation tests now select the actual Item version and rebase only the expected duplicate
guard revision when the Replica changes. The 13 stopped-operation regressions pass with their
ownership, receipt and replay assertions retained. Web mutation lifecycle fixtures now include
the required edit guard; all 11 lifecycle tests pass with their original cancellation and
late-result assertions. These test-only CI corrections were independently reviewed. Both
literal full CI gates remain required before resolution; this does not activate Desktop or
Extension Runtime composition.

2026-09-09: actual Core projections expose persisted private passkeys; Web Export copies those
projections, and Desktop removal and Duplicate reconstruct full private drafts. Redacting the field
alone would drop existing behavior. The focused contract separates public metadata, guarded ordinary
edits and semantic actions from explicit private transfers, using existing deep owners. Coordinating
and independent reviews passed the source mapping and lifecycle choices. No unresolved product choice
remains in this slice. Its incomplete ticket71 dependency still blocks implementation; readiness is
not delivery or Desktop/Extension acceptance.

2026-09-09 final independent contract review passed. The95/66/72/75 dependency closure is acyclic;
95 has no74/75 ancestor, and75 extends the same explicit Export owner after its floor capability.
The reviewed draft/edit/remove/Duplicate/private-transfer boundaries require no additional policy
owner. All36 scoped local links and anchors resolve. This is specification readiness only; the
incomplete71 prerequisite still blocks implementation.

2026-09-23 semantic command shape: Core publishes a lowercase SHA-256 fingerprint of the exact
persisted passkey `publicKey` UTF-8 bytes alongside public metadata. This is stale-selection
evidence, not an RSA canonical trust fingerprint or a new credential security protocol; a stored
encoding change changes the fingerprint without adding a decoder refusal for readable Items.
`RemovePasskey` carries Account/Item, current `ItemEditGuard`, RP ID, credential ID and that
fingerprint, and removes exactly one current match under the existing Item mutation and Account
execution fences. `DuplicateItem` carries Account/source Item, replacement title and a Core-issued
source guard with Account/incarnation/epoch, source Item/Vault, Replica revision and either its
authoritative Item version or exact accepted readable overlay owner ID. Core validates that this
guard still describes the selected readable source while admitting the same-Vault Create. A
readable trashed source remains duplicable into a new active Item, as in the Desktop action;
permanent tombstones, hidden or unreadable sources are refused. These internal private drafts do
not become ordinary protocol drafts.

2026-09-23 implementation checkpoint: ordinary Login projections and editable drafts contain
public passkey metadata only, and guarded Update merges the current private credentials in Core.
The focused Core test creates a real ES256 credential, edits its Login through the public draft,
checks the original credential bytes in the encrypted Item and signs with the preserved key. It
then carries that key through the existing scoped private Export projection and explicit
Import command, decrypts the imported Item and signs again. Semantic RemovePasskey and same-Vault
Duplicate use Core-issued selection guards; the Core create/command suite passed 59/59, including
overlay, stale identity/version/epoch, readable trash, five-category and sibling-credential cases.
Ordinary forged private input is rejected. The generated Runtime contract tests passed 19/19,
native bindings generation/check and strict native Clippy passed, and Web edit/export focused tests
passed 50/50. Native Login draft/projection types are opaque UniFFI objects so generated Kotlin and
Swift stringification does not include their plaintext fields; the hardening artifact tests passed
4/4. On the final WASM build, actual Web Item CRUD browser tests passed 7/7 and the selected
Import/Export browser cases passed 2/2: a `.bttrx` archive round-trip and imported optional fields
and favorites surviving UI edits and a real Export in all five categories. Full repository CI
remains pending at this checkpoint; Desktop and Extension gesture cutovers remain in their
dependent tickets.
