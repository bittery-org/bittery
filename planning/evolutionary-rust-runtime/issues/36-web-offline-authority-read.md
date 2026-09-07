# Web offline authoritative Replica read

Type: task
Status: resolved
Blocked by: 32, 35
Spec: ../spec.md#bootstrap

## Delivered

Delivered in `bb4ec003`: real Worker replacement, online unlock, observation recreation after
disconnection, and a rendered Item from byte-identical Account-scoped encrypted Replica authority.
The scenario forbids successful post-disconnect API responses; it does not prohibit retry attempts.

## Contract

- Add one Playwright scenario using the real Runtime composition root and full Rust authentication.
- Create and Bootstrap an authoritative encrypted Login Item while online, then replace the Worker
  and prove the Account restores locked with the same encrypted authority.
- Complete one online password Quick Unlock or Full Sign-in, wait until local decryption is ready,
  disconnect every subsequent Server transport, and navigate/render the same Item from the Replica.
- Prove no post-disconnect Bootstrap, changes, Item authority fetch, or legacy repository read
  supplies the result; assert the plaintext marker is absent from IndexedDB and diagnostics.

## Verification

The focused cloud scenario, Web types, and both full CI gates passed at delivery.
