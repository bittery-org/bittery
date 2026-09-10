# `@bittery/crypto-port` — design context

Where key material crosses a platform boundary, who owns its lifetime, and what the shared
adapter suite can and cannot establish.

```
                   apps
                    |
              VaultCrypto                    account ceremonies and envelope policy
               /        \
      AccountStore      CryptoPort            deep modules over a dumb, total seam
               \        /
        PlatformPort   wasm-worker · wasm · wasm-static
                              |
                         Rust crypto core      algorithms and formats
```

`CryptoPort` has 40 required, asynchronous members. Callers never feature-detect a crypto
capability and adapters never choose policy: each adapter satisfies the same complete
contract or fails to typecheck. The algorithms and persisted formats remain in the single
Rust core described by ADR 0001.

---

## 1. A `KeyRef` is an identity with a lifetime

A `KeyRef` is a brand-only token with no readable members. It identifies symmetric key
material held by the port instance that minted it; it is not the material itself. A ref is
not serialisable or persistable, cannot be used with another port instance, and becomes
unusable after `destroyKey`. `destroyKey` is idempotent for a ref from that port, while a
foreign ref and any later non-destroy use of a destroyed ref throw.

The ownership rule is deliberately small:

| operation | ownership |
| --- | --- |
| A port member returns a fresh `KeyRef`, including either member of `DerivedKeyRefs` | the caller owns it and must eventually call `destroyKey` |
| A port member receives a `KeyRef` argument | it borrows the ref for that call and does not retire it |
| `cloneKey` returns a ref | the caller owns the clone; it has a lifetime independent of the source ref |
| `destroyKey` receives a ref | the owner explicitly ends that ref's lifetime |

This applies on success and failure paths. Code that creates several refs must retire every
one it still owns, including one created before a later operation rejects.

`AccountStore` is the important ownership boundary above the port:

- `storeSessionData` borrows a MUK long enough to wrap it and retains no ref.
- `setMasterUnlockKey` takes ownership. Once it succeeds, the store destroys that ref when
  the account locks, signs out, is removed, or the cached key is replaced.
- `getMasterUnlockKey` returns the store-owned cached ref. Callers borrow it and must not
  destroy it.
- `decryptStoredMasterUnlockKey` does not unlock the account. It returns a fresh,
  caller-owned ref which the caller must destroy or transfer to `setMasterUnlockKey`.

The login helper `storeLoginSessionOwned` owns the transfer protocol: it destroys the
caller-owned MUK if session setup fails before `setMasterUnlockKey` accepts it, and leaves the
live ref with the store after that point.

---

## 2. The seam carries primitives, not policy

`CryptoPort` sits below `@bittery/storage` because `AccountStore` needs key lifecycle and
wrapping primitives to protect the cached session material. `VaultCrypto` sits above storage
because account ceremonies and vault-key operations interleave crypto with reads, writes and
server commits. Combining them would either make storage depend on account policy or make the
port depend on the store it is meant to serve.

The port refuses to own:

- application envelope policy, including wrap-context construction and validation;
- account ceremonies and the decision of what to persist or commit;
- KDF-profile validation and pinning;
- Secret Key and Recovery Key hint extraction; and
- base64 utilities used by application and storage code.

Those decisions live in `VaultCrypto`, `AccountStore` or `@bittery/shared` as appropriate.
Envelopes, ceremonies and KDF pinning depend on account policy and state; hints and base64
helpers are deterministic conversions that need no platform crypto backend.
Some Rust primitives return an opaque persisted envelope, such as
`encryptVaultKeyWithMuk`; the port forwards that core-owned format but does not construct,
interpret or decide when to persist it.

Key-opening primitives return a fresh `KeyRef`. `unwrapKey` authenticates caller-supplied
AAD, while `VaultCrypto` validates the vault envelope and supplies its exact context. `decryptRsaWrappedKey`
keeps both the decrypted private-key PEM and RSA-unwrapped symmetric key below the seam.

---

## 3. Three adapters, one generated-handle model

The three production adapters and the in-memory fake share the same contract:

| consumer | adapter | material behind a `KeyRef` |
| --- | --- | --- |
| web, desktop and mobile | `wasm-worker` | a generated UniFFI `KeyHandle` in the crypto worker; the main thread holds only its own opaque token |
| browser extension | `wasm-static` | a WASM key-table handle in the same JavaScript context, loaded without dynamic `import()` |
| tests | `in-memory-crypto` | an in-process boxed value behind the same ref table; its cipher is deliberately not secure |

On web, port arguments cross the main-thread/worker boundary as worker handles, not key
bytes. When a Rust binding itself requires base64 key material, that conversion stays inside
the worker. `decryptMany` is one worker round trip for the whole batch. Desktop uses the same
worker adapter, including mobile — the Tauri app runs the same worker inside its WebView. The
extension has no worker boundary: its ref maps directly to a handle in its same-context WASM
table.

Android's credential provider is the one crypto consumer outside this port. It runs in its own
process, cannot reach the WebView, and calls the UniFFI Kotlin in `packages/crypto/android`
directly.

---

## 4. `exportKey` is an explicit, total escape hatch

`exportKey` returns a copy of the raw bytes behind **any** live ref. The type system cannot
distinguish a device-key ref from a MUK ref and cannot stop a caller exporting either one.
The operation exists because a platform has to persist its root device key and nothing on
that device can wrap the root.

The statement that a plaintext MUK stays out of web's main-thread JavaScript is therefore a
convention, not a structural guarantee: it holds because no production web caller invokes
`exportKey` on a MUK. The worker boundary and the opaque token make accidental access harder,
but the total port member remains available.

Mobile has one audited exception to the usual MUK convention.
`apps/mobile/src/services/credential-provider-master-unlock-key.ts` borrows an unlocked MUK
from `AccountStore`, exports it, immediately base64-encodes it and passes it to the frozen
Android credential-provider API in a separate native process. The helper does not own or
destroy the borrowed store ref. This interoperability boundary is not a general allowance
to export MUKs.

---

## 5. What adapter conformance establishes

`src/adapters/port-conformance.ts` is one suite body run against all three adapters and the
in-memory fake. Two rules are load-bearing:

1. **No platform import.** The shared suite sees only `CryptoPort`; importing Worker, WASM,
   Tauri or Expo would test an implementation instead of the seam.
2. **No branching on `name`.** The name labels test output only. A platform-specific branch
   would turn a required contract into a capability exception.

The suite pins what the TypeScript layer owns: member totality, argument and result
marshalling, base64 boundaries, `KeyRef` identity and lifetime, error-code translation, batch
ordering and isolation, and observable call composition. Each production adapter runs those
checks over a doubled backend; the fake is the fourth subject.

## 6. What conformance does not prove

No real production backend loads under `bun:test`: web and desktop use browser-built WASM,
React Native requires its generated native module, and the extension requires its MV3 runtime.
A green adapter suite can
therefore miss a defect shared by an adapter and its double. It does not prove an algorithm,
the bytes of a ciphertext, native linking, backend startup and teardown, performance, or
cross-platform interoperability. Those belong to Rust tests and format vectors, native
build/device checks, and a manual test that one platform can open a vault key wrapped by
another.

In particular, no automated test executes web's production worker construction:
`new Worker(new URL("../wasm.worker.ts", import.meta.url), { type: "module" })`. The form is
consumed by Vite only when the real web app loads it, so the web smoke test remains required.
