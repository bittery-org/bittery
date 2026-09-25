# Mandatory recipient key verification

## Contract

- Existing RSA-OAEP wrapping, RSA identity keys and persisted ciphertext formats remain unchanged.
- Crypto Core derives a versioned, full SHA-256 fingerprint from canonical SPKI DER. PEM line endings
  cannot change identity. Invalid/non-RSA keys fail closed. Own identity is derived from the locally
  decrypted RSA private key; the Server's public-key field is not evidence of one's own fingerprint.
- Runtime accepts an explicitly supplied out-of-band fingerprint and compares it to the candidate
  key before storing verification. No checkbox, blank fingerprint or first-use shortcut grants trust.
- Runtime stores the verified fingerprint against recipient User ID in a separate Device-local
  Account-incarnation document, bound to canonical Server and local User identity. Lock/restart do not
  clear it. Account removal/Wipe clear it. New incarnation, missing storage or new Device starts empty.
  Corrupt/unavailable storage fails closed; Server responses and recovery never populate it.
- A Runtime lookup returns the exact candidate public key only if its canonical fingerprint matches
  the retained verification. Unknown and changed keys return distinct closed error codes. Explicitly
  verifying a changed key replaces that User's record. All requests require the same live unlocked
  Account generation, cancellation/teardown checks and serialized Account execution.
- Web shares one prompt and one verified-key wrapper. It captures Account identity before asynchronous
  work and never switches to another Account to finish an outstanding gesture. Cancelled verification
  sends no wrapped key to that recipient; already-submitted work cannot be recalled. Verification
  failures are not swallowed by invitation provisioning.
- Add-Member, existing-User Invitation provisioning and every other-Member rotation wrapper use the
  Runtime-returned key. The current User's rotation copy remains MUK-wrapped. Existing encrypted plan
  transport/orchestration stays transitional; it holds no recipient-trust rules. Earlier successfully
  verified recipients may be staged before a later recipient blocks; no unverified wrapper is staged.
- Invitation responses include the existing recipient's User ID alongside their public key. An
  invitation created without Vault keys may remain pending if verification is cancelled; no automatic
  sharing is inferred. UI reports this state without claiming Vault access was provisioned.
- Settings exposes the own-key fingerprint for out-of-band comparison. Prompts explain comparison
  with the recipient through an independent channel and require their fingerprint to be entered.
- This protects against API public-key substitution with an honest installed client. It cannot protect
  a Web client whose delivered JavaScript has itself been maliciously replaced, or revoke data already
  disclosed. No stronger guarantee is added to SECURITY.md before production acceptance.

## Acceptance

1. Real RSA fixtures: substituted key is rejected at first contact; explicit wrong fingerprint cannot
   create trust; correct verification enables only that key; changed key blocks until reverified.
2. Canonical encodings agree; different keys differ; malformed input fails; own fingerprint uses the
   private key even if the Server public key is substituted.
3. Runtime requests cover Account/Server/User isolation, restart, Lock, cancellation, storage failure,
   malformed persistence, and removal. Verification becomes usable only after successful persistence.
4. All three production callers require the Runtime-returned key. Host tests prove no wrapping/upload
   on refusal or cancelled verification and use the approved key rather than stale response data.
5. Generate protocol/native/Server bindings normally; validate affected types, Core/crypto and host
   tests, then phase CI. Independent review and simplification precede closure.

## Implementation and validation — 2026-09-10

The implementation is on `pivot/rust-client-core`, not a released-client change. Rust owns fingerprint
derivation, independent comparison, durable verification and Account-generation admission. The
transitional Web orchestration still calls the existing Rust crypto wrapper with the exact public
key approved by Runtime; this is not a claim that all rotation transport has migrated into Runtime.

Passed:

- Five focused `bittery-client-core` recipient-key tests, including real-RSA first-contact/key-change
  substitution, persistence failure, scope changes, Lock, storage reopen, removal/Wipe and duplicate
  record rejection. The original reproducing test was introduced before the policy implementation.
- Full Crypto workspace tests: 152 Core and 11 interoperability tests, including canonical
  fingerprints and deriving one's public identity from the decrypted private key.
- Fifteen focused Web/rotation tests: rejection and cancellation prevent wrapping/submission;
  rotation uses the approved key and stops before prompting the next recipient after cancellation.
- Invitation API integration test: the existing recipient's User ID accompanies their public key.
- Fifty generated-contract/native-binding generator tests; protocol, native, Server and Web bindings
  regenerated through the normal generators.
- Independent read-only design/security review after the cancellation and lifecycle fixes: no
  remaining blocking findings. Simplification removed concurrent recipient prompts during rotation.

Phase acceptance remains open. `pnpm check:ci:rust` stops at unrelated formatting in
`runtime/live_sync_session_lifetime_tests.rs`; a separate workspace Clippy run reports two
`type_complexity` findings and one `unnecessary_filter_map` in `runtime/native_travel.rs`.
These files were not changed for this fix. The initial full TypeScript-suite timeout failures pass
when rerun separately, and the subsequent `pnpm check:ci` run passed completely, including all 14
package tasks and the final Chromium harness. Dedicated sharing browser results are recorded on
ticket 101.

Browser preparation originally stopped at personal-to-team conversion, before verification.
The Teams fixture now creates a team Vault through the normal create dialog; the dedicated
conversion tests remain unchanged. This isolates sharing acceptance without fixing or hiding the
separate conversion failure. Own fingerprint display has succeeded through real signup and Settings.
Team navigation now uses the live app links, and the targeted rotation scenario explicitly unlocks
after deliberate reloads; a restarted Runtime is correctly locked, not implicitly authenticated.
