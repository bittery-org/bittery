# Current client architecture

## Topology

**Observed.** Four React-family clients consume a shared TypeScript package graph:

```text
apps/web       apps/desktop       apps/mobile       apps/extension
      \              |                |                 /
       core · storage · sync · shared · types · crypto-port
                            |
                       Rust crypto core
```

The important package interfaces are visible in `packages/*/package.json` and their source exports.

## Strong concepts

- **Observed:** one Rust cryptographic implementation compiled for clients and Server.
- **Observed:** opaque `KeyRef` identities with explicit ownership and destruction.
- **Observed:** generated cross-language definitions and drift guards.
- **Observed:** explicit storage sensitivity/lifetime classification.
- **Observed:** encrypted local cache with staged bootstrap/promotion.
- **Observed:** the extension Vault-session transition function is pure and effect-producing.
- **Observed:** app code can use React-free core modules in extension background contexts.

Evidence:

- [`docs/adr/0001-single-rust-crypto-core-for-every-platform.md`](../../../legacy/docs/adr/0001-single-rust-crypto-core-for-every-platform.md)
- [`docs/adr/0005-vault-session-is-a-pure-reducer-that-imports-nothing.md`](../../../legacy/docs/adr/0005-vault-session-is-a-pure-reducer-that-imports-nothing.md)
- [`docs/adr/0009-key-material-crosses-seams-as-an-opaque-keyref.md`](../../../legacy/docs/adr/0009-key-material-crosses-seams-as-an-opaque-keyref.md)
- [`docs/adr/0012-one-generated-definition-per-cross-language-type.md`](../../../legacy/docs/adr/0012-one-generated-definition-per-cross-language-type.md)
- [`packages/storage/CONTEXT.md`](../../../legacy/packages/storage/CONTEXT.md)

## Architectural pressure

**Observed.** The effective client engine is distributed across:

- `packages/core/src/services/account-vault-replica.ts`
- `packages/core/src/services/vault-repository.ts`
- `packages/core/src/services/vault-crypto.ts`
- `packages/storage/src/account-store.ts`
- `packages/storage/src/item-cache.ts`
- `packages/sync/src/outbound-queue.ts`
- `packages/sync/src/sync-orchestrator.ts`
- per-app lifecycle and provider composition

**Observed.** `PlatformProvider` receives storage, cache, crypto, credential mirroring, Vault crypto,
Vault runtime, Account manager, auto-lock, and Sync. Near-identical provider/composition modules exist
under Web, Desktop, mobile, and extension.

**Observed.** `AccountStore` and `ItemCache` are public sibling modules over different adapters.
Sign-out, Account removal, and related destructive operations must preserve cross-store invariants in
callers above both interfaces.

**Observed.** Sync policy spans outbound queue, orchestrator, event application, bootstrap, repository,
React binding, and per-host lifecycle. Desktop and mobile have materially similar host assembly, while
the extension reconstructs additional background behavior.

**Observed.** Desktop-extension integration is a large tier-spanning subsystem covering native
messaging, IPC security, lock authority, snapshots, key handling, and recovery.

**Observed.** Current mobile uses a WebView plus platform-native islands. The Android credential path
has duplicated representation and historically exported master-unlock-key material across the
TypeScript/native seam.

## Greenfield lesson

The existing security rules are valuable. Their ownership is too exposed. The greenfield target
places session, replica, command, crypto, and Sync behavior behind one deep Rust `ClientRuntime`
interface and leaves UI/platform code as adapters.
