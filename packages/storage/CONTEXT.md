# `@bittery/storage` — design context

Where persisted values live, who decides, and which invariants the compiler cannot enforce
for you. Code comments elsewhere in the repo cite this file by section.

```
   auth-service / apps / vault-repository
            |
   +--------+---------+
   |                  |
AccountStore      ItemCache          deep modules; ALL policy lives here
   |   |              |
   |  CryptoPort      |              a third seam, owned by @bittery/crypto-port
   |                  |
PlatformPort      RecordPort         seams; dumb, total, zero optional members
   |                  |
tauri rn chrome web                  pure mapping, no policy
```

A `PlatformPort` / `RecordPort` primitive takes a `string` and returns `string | null`. No
JSON, no encryption, no accountId, no defaults, no expiry, and no optional members anywhere
in any of the three ports or in `AccountStore` / `ItemCache`. Every method is total, so the
compiler verifies that an adapter satisfies the contract — there is nothing to feature-detect
at a call site.

---

## 1. Storage tiers

`src/tiers.ts` is the security artifact: it answers "where does `vault_keys` live, and how
long does it live there?" for every platform at once.

Two universal axes, declared per value; placement is derived, never declared.

| axis | values | meaning |
| --- | --- | --- |
| `tier` | `secret` \| `plain` | sensitivity — picks the backing store |
| `class` | `session-bound` \| `device-bound` | lifetime — does it die with the session? |

```ts
deriveScope(valueClass, sessionSurvivesRestart): "session" | "device"
```

A `session-bound` value on a platform whose session dies with the process gets scope
`session`. Everything else gets `device`. `sessionSurvivesRestart` is declared once per
adapter: `false` on web and the extension, `true` on desktop and mobile.

Routing, in `AccountStore` and nowhere else:

```ts
const scope = deriveScope(STORAGE_TIERS[name].class, port.sessionSurvivesRestart);
if (scope === "session")             return port.kvGet(key, "session");
if (STORAGE_TIERS[name].tier === "secret") return port.secretGet(key);
return port.kvGet(key, "device");
```

A platform with a real keychain is exactly a platform whose session survives restart, which
is why `secretGet`/`secretSet` need no scope parameter.

### What backs the `secret` tier

Every adapter declares `PlatformPort.secretBacking` as a human-readable string. That string
is the security-review answer, and it must stay honest:

| platform | `secretBacking` |
| --- | --- |
| desktop | OS keychain (macOS Keychain / Windows Credential Manager / libsecret) via Tauri `keychain_*` commands |
| mobile | `expo-secure-store` (iOS Keychain / Android Keystore-backed `EncryptedSharedPreferences`), chunked for values over the platform size limit |
| web | `localStorage` — **no** at-rest separation from the plain tier; the browser profile is the trust boundary |
| extension | `chrome.storage.local` — **no** at-rest separation from the plain tier; the browser profile is the trust boundary |

Web and the extension honour `secret` by mapping it onto their only store and saying so
loudly rather than pretending otherwise. `assertTiersHonoured` runs at startup so a port
that declares it *cannot* honour a tier fails immediately instead of silently demoting.

Size never decides placement. Mobile chunks a large secret across multiple SecureStore
entries; it never falls back to plaintext SQLite.

### The plaintext master unlock key is never persisted

On any platform. In normal web flows it also stays out of main-thread JavaScript.
`AccountStore` caches the MUK as an opaque `KeyRef`: the material behind it lives in the
crypto adapter — a WASM key table inside web's worker thread or the extension's JavaScript
context, and a boxed `Uint8Array` that `destroyKey` zeroizes on desktop and mobile — so what
this package holds is an identity token with no readable members. The cache is session-bound
by construction, which is why `STORAGE_TIERS` has no row for it. What *is* persisted is
`session_data`, carrying the MUK **wrapped under `device_key`** (`wrapKey` in, `unwrapKey`
out, so no plaintext appears on either side of the call). That pair is device-bound so
desktop and mobile can quick-unlock after a restart.

Locking **destroys** rather than forgets: `clearMasterUnlockKey`, `clearSession`,
`lockAllAccounts` and `removeAccount` all call `destroyKey`, so the material is zeroized and
every ref a caller still holds throws on use. The store owns the ref it hands back from
`getMasterUnlockKey` for exactly as long as the account is unlocked; a caller must not
destroy it. `decryptStoredMasterUnlockKey` is the one exception — it mints a fresh ref that
belongs to the caller, because it deliberately does not unlock the account.

**Reading the key never unlocks.** `getMasterUnlockKey` reports the cache and nothing else,
so `null` is the honest answer to "is this account unlocked?". Unlocking is always an
explicit call: `tryRestoreSession`, `tryRestoreSessionWithoutPrompt`, `unlockWithBiometric`,
`unlockAllAccountsWithBiometric` or `setMasterUnlockKey`. The reason is not tidiness — the
read is on the vault-key unwrap path, once per item, so a read that could restore the
session raised one OS biometric prompt per cached item on a locked account. A JS context
with its own cache (a web page load, the extension popup, an app launch) therefore restores
at boot with `tryRestoreSessionWithoutPrompt`, which resumes only where no user interaction
is due and otherwise leaves the account locked for an unlock flow to handle.

### What "never reaches JS" actually rests on

A convention, not a structural guarantee, and this document will not pretend otherwise.
`CryptoPort.exportKey` is a total member that returns raw bytes for any live ref, so nothing
in the type system stops someone calling it on a MUK. The web claim holds because no
production web caller does. Mobile intentionally does so at one audited boundary:
`apps/mobile/src/services/credential-provider-master-unlock-key.ts` borrows the store-owned
MUK, immediately base64-encodes its exported bytes and hands them to Android's frozen
credential-provider API in a separate process.

`exportKey` exists for the **device key**, which is the asymmetry worth understanding: it has
to be persisted, and nothing on the device can wrap it. `AccountStore` mints it with
`generateEncryptionKey`, exports it once, base64s it into the secret tier and from then on
only ever `importKey`s it back — the one and only `exportKey` call site in this package, and
the reason the member is on the port at all. Storage touches exactly six of the port's 38
members (`generateEncryptionKey`, `exportKey`, `importKey`, `wrapKey`, `unwrapKey`,
`destroyKey`) and nothing else.

`jwt_token`, `vault_keys` and `encrypted_private_key` are session-bound: gone after a
browser or extension restart, retained on desktop and mobile.

---

## 2. `PlatformPort`, `RecordPort` and `CryptoPort`

Three seams, all dumb and total. `AccountStore` sits over two of them — one for where a
value lives, one for the key material it is protected with — and `ItemCache` over the third.

**`PlatformPort`** (`src/platform-port.ts`) — 8 primitives plus 5 readonly declarations
(`platform`, `sessionSurvivesRestart`, `tiers`, `secretBacking`, `recordKeyPrefix`) and a
`BiometricPort`. `secretGet/Set/Delete` take a key; `kvGet/Set/Delete` take a key and a
`StorageScope`; `kvListKeys` takes a prefix.

**`RecordPort`** (`src/record-port.ts`) — 5 primitives for bulk encrypted blobs, keyed by an
opaque `collection` string that ports must not parse. `recordPut` and `recordDelete` **must
be O(1)** — no read-array, mutate, rewrite. Delta sync upserts one item at a time, and that
is the whole reason this port is separate.

**`CryptoPort`** (`@bittery/crypto-port`) — the one seam this package does not own, injected
as `AccountStoreOptions.crypto`. It is total in the same sense as the other two: 38 members,
all required and all async. Symmetric keys are represented as opaque `KeyRef`s except at the
explicit `exportKey` escape hatch described in §1. That is what lets `AccountStore` hold a
single `Map<string, KeyRef>` for the MUK cache. The
`CryptoProvider` this package used to declare had 3 required members and 7 optional ones, and
the MUK cache was a `number | Uint8Array` union to straddle them — every `if (crypto.x)`
capability check in this package existed for that reason, and all of them are gone. Storage
uses six members (§1) and asks the port for nothing policy-shaped: the wrapped-vault-key
envelope, wrap contexts and the account ceremonies all live **above** this package, and
`getPinnedKdfProfile` enforces the shared KDF policy here without the port ever seeing it.

Rules that hold for both storage ports:

- A missing key returns `null`. Never throws, never returns `undefined`.
- Deleting an absent key is a no-op, never throws.
- Setting overwrites silently.
- `""` is a value, distinct from absent. No production value is ever `""`, but the
  conformance suite asserts the distinction so a port cannot quietly collapse them.

`BiometricPort.authenticate` returns a `BiometricPortResult`, not a boolean. A bare boolean
would collapse "the user pressed cancel" into "authentication failed", a distinction the UI
makes today. Ports translate their native error into the closed set
(`user_cancelled` / `lockout` / `not_enrolled` / `not_available` / `failed`) and do nothing
else with it.

`src/adapters/port-conformance.ts` is one suite body run against all four adapters plus the
in-memory fake. It imports no platform module and never branches on the adapter's name — if
it needed to, the seam would be leaking policy.

---

## 3. `AccountStore` and `ItemCache` are siblings

`ItemCache` is **not** reachable through `AccountStore`. They sit side by side over
different ports, because their failure modes differ: losing an `AccountStore` value can lock
a user out, whereas losing the item cache costs a re-sync.

The consequence is the invariant in §4.2 — anything that drops a session or an account has
to drop *both*, and only the caller can sequence the two.

`ItemCache` (`src/item-cache.ts`) namespaces by account into three collections:
`${accountId}:items`, `${accountId}:vaults`, `${accountId}:meta`. The helpers that build
those names live in `src/keys.ts` and are imported by both `item-cache.ts` and
`account-store.ts` (for the native projection), so the cache and the projection cannot
disagree about a prefix.

`getCachedItems` returns `null`, not `[]`, when nothing has ever been cached — callers
distinguish a cold cache from an empty vault.

`removeCachedVault` also removes that vault's cached items.

---

## 4. Invariants the types cannot enforce

### 4.1 An account identity is an accountId, and it is never optional

Every `ItemCache` method takes a required `accountId`. There is no implicit fallback: the
literal `"default"` segment this section used to describe is gone, because an omitted id
silently read and wrote the wrong collection instead of failing.

Two rules keep it that way, and both are load-bearing:

- **An email is not an identity.** Emails, userIds, serverUrls and vaultIds are all bare
  strings too, and passing one where an accountId belongs names a collection after it.
  `resolveAccountScopeId` maps a scope (accountId or display email) to an accountId
  and **throws** when it cannot, so an unresolved scope fails loudly at the boundary rather
  than quietly downgrading to whichever account happens to be active.
- **`AccountStore` still resolves an omitted `accountId` to the active account**, which is
  correct for UI code that genuinely means "the current account" — but it is a *different*
  answer from what `ItemCache` would have given. That divergence is why nothing may reach
  either seam with an unresolved identity.

### 4.2 Dropping a session must also drop the item cache

`AccountStore` holds no `RecordPort` and cannot reach the cache (§3). So
`clearSession`, `forgetSession` and `removeAccount` do not touch it, and **the caller must
sequence `itemCache.clearItemCache(accountId)` alongside them**. Leaving an encrypted cache
on disk after its keys are gone is a real leak.

Note that lock is deliberately not sign-out:

| call | `session_data` | quick-unlock afterwards |
| --- | --- | --- |
| `clearSession` | kept | yes |
| `forgetSession` | deleted | no |

### 4.3 `getUnlockedAccounts` means "this JS context holds a live MUK ref"

Not "could be unlocked". It performs no I/O and restores nothing. After an extension
service-worker restart it reports zero unlocked accounts until something calls
`tryRestoreSession` — so the service-worker startup path must restore explicitly.

### 4.4 Desktop keychain failure is fatal, by design

There is no plaintext mirror of `device_key` to fall back on; that mirror was the leak this
design removes. A desktop with a broken OS keychain therefore throws rather than limping.
Nothing retries or reports it specially.

### 4.5 The extension's MUK cache is per-JS-context

`AccountStore`'s in-memory MUK cache and its `onUnlockStateChanged` listeners live in one JS
context. A popup unlocking does not notify the service worker. This is currently harmless
only because the extension routes every unlock through the service worker — keep it that
way.

---

## 5. The native-host view

The desktop native messaging host reads `store.json` directly and must never re-derive a key
or a default. `AccountStore` publishes everything it needs as a single JSON document under
`bittery_native_view`:

- Every key the host opens is **named in the document**, and every value the host would
  otherwise default is **written resolved**. No `format!("bittery_account_{}_{}", …)` on the
  Rust side, no `unwrap_or(true)` for biometric, no `unwrap_or(600000)` for auto-lock.
- A `NativeKeyRef` carries `{ key, store: "secret" | "plain" }` so Rust never decides where a
  value lives.
- Each account publishes a plain `itemCacheState` ref to ItemCache's one metadata record.
  ItemCache writes the active generation and its fully-resolved `nativeView` prefix pair in
  that same record, using `RecordPort.recordKeyPrefix` (`"record:"` on desktop, `""`
  elsewhere). The Rust host reads that narrow projection on every snapshot, so it follows a
  promotion atomically without either sibling depending on the other or reconstructing a
  record key.

**`NATIVE_VIEW_VERSION` is 3, and bumping it is a coordinated change.** The Rust parser
checks `v` before interpreting any other field. A desktop binary and a JS bundle that
disagree refuse each other's view and report zero accounts — the intended failure mode, but
it means both must ship together.
