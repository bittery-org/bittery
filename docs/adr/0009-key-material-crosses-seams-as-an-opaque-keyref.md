# Key material crosses seams as an opaque `KeyRef`

Symmetric keys are represented at ordinary TypeScript package and `CryptoPort` call sites as
a port-scoped `KeyRef`, not as a `Uint8Array`; `exportKey` is the explicit exception described
below. A ref is an identity token with no readable members, and the generated binding owns the
opaque `KeyHandle` behind it. Passing a ref borrows it, a fresh returned ref belongs to the
caller, and `destroyKey` ends its lifetime. A ref from another port instance and a ref used
after destruction both fail explicitly.

Raw byte arrays made ownership invisible. They could be copied, retained, persisted or sent
across a worker boundary with no signal in the type, and clearing one view could not retire
the other copies. An opaque identity gives every ref one auditable lifetime and lets web keep
main-thread calls handle-shaped. It also makes a total cross-platform contract possible:
Generated UniFFI clients map refs to native key-table handles, while each platform adapter
keeps the same interface instead of exposing a second byte-oriented API.

This opacity is not a claim that plaintext cannot exist in JavaScript. The extension's WASM
key table is in its JavaScript context, and web bindings that require raw material perform
their conversion inside the worker. More importantly, `exportKey` is a
total member for every live ref. It must exist because a platform persists its root device
key and nothing else can wrap that root. The type system cannot prevent exporting a MUK.
Web's plaintext MUK staying out of main-thread JavaScript is a convention maintained by no
production web caller invoking `exportKey` on one, not a structural guarantee.

Mobile has one deliberate exception. The Android credential provider runs in a separate
native process behind a frozen base64 API, so
`apps/mobile/src/services/credential-provider-master-unlock-key.ts` exports a borrowed MUK,
immediately base64-encodes it and hands it across that boundary. Centralising that operation
in one helper makes the exception auditable; it does not change ownership of the store's ref
or license other MUK exports.

`CryptoPort` sits below `@bittery/storage` because `AccountStore` must generate, import,
wrap, unwrap and destroy keys while implementing session persistence. The port is total and
policy-free: it does not know storage tiers, accounts, server commits, KDF pinning, hint
formatting or application envelope fallback. `VaultCrypto` sits above storage because vault
key envelopes and account ceremonies need both crypto primitives and account state. Putting
those layers in one package would either pull account policy below the platform seam or make
storage depend on a service that already depends on storage.

The shared conformance suite tests the part owned by the TypeScript binding layer:
marshalling and base64 boundaries, total member mapping, ref lifetime, error translation,
batch behaviour and observable call composition. It imports no platform module and never
branches on the adapter name; either move would turn the shared contract into
platform-specific policy.

It deliberately does not assert ciphertext bytes or algorithms. No production backend can
load in `bun:test`, so each of the three adapters runs over a double and the in-memory fake is
a fourth subject. Testing ciphertext against those doubles would only certify the doubles,
while duplicating algorithm expectations in TypeScript would undermine the single Rust core
chosen in ADR 0001. Rust tests and format vectors own algorithms and persisted formats;
native/device checks and a real cross-platform unwrap own binding and interoperability
confidence. The adapter suite can still miss a defect shared by an adapter and its double,
and it does not execute the real web Worker URL.

The trade-off is explicit lifetime bookkeeping at every call site, `finally` blocks around
fresh refs, and ownership-transfer APIs where a store takes a key. Platform boundaries may
still require explicit copies, and `exportKey` remains an unavoidable escape
hatch. In return, one all-async port replaces platform capability probes and byte/handle
unions, the compiler finds unmigrated key call sites, and accidental key propagation becomes
an exceptional operation instead of the default representation.
