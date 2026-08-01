# `@bittery/storage` — design context

Where persisted values live, who decides, and which invariants the compiler cannot enforce
for you. Code comments elsewhere in the repo cite this file by section.

```
   auth-service / apps / vault-repository
            |
   +--------+---------+
   |                  |
AccountStore      ItemCache          deep modules; ALL policy lives here
   |                  |
PlatformPort      RecordPort         seams; dumb, total, zero optional members
   |                  |
tauri rn chrome web                  pure mapping, no policy
```

A port primitive takes a `string` and returns `string | null`. No JSON, no encryption, no
accountId, no defaults, no expiry, and no optional members anywhere in either port or in
`AccountStore` / `ItemCache`. Every method is total, so the compiler verifies that an
adapter satisfies the contract — there is nothing to feature-detect at a call site.

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

On any platform. It lives only in `AccountStore`'s in-memory cache, and is therefore
session-bound by construction. What *is* persisted is `session_data`, carrying the MUK
**encrypted under `device_key`**. That pair is device-bound so desktop and mobile can
quick-unlock after a restart.

`jwt_token`, `vault_keys` and `encrypted_private_key` are session-bound: gone after a
browser or extension restart, retained on desktop and mobile.

---

## 2. `PlatformPort` and `RecordPort`

Two seams, both dumb and total.

**`PlatformPort`** (`src/platform-port.ts`) — 8 primitives plus 5 readonly declarations
(`platform`, `sessionSurvivesRestart`, `tiers`, `secretBacking`, `recordKeyPrefix`) and a
`BiometricPort`. `secretGet/Set/Delete` take a key; `kvGet/Set/Delete` take a key and a
`StorageScope`; `kvListKeys` takes a prefix.

**`RecordPort`** (`src/record-port.ts`) — 5 primitives for bulk encrypted blobs, keyed by an
opaque `collection` string that ports must not parse. `recordPut` and `recordDelete` **must
be O(1)** — no read-array, mutate, rewrite. Delta sync upserts one item at a time, and that
is the whole reason this port is separate.

Rules that hold for both:

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

### 4.1 The `"default"` account segment is web-only

`ItemCache` falls back to the literal account segment `"default"` when `accountId` is
omitted. That is only ever correct on web. **Every other call site must pass an explicit
accountId.** A missed one silently reads and writes the wrong collection instead of
failing — the worst kind of bug this codebase can have.

### 4.2 Dropping a session must also drop the item cache

`AccountStore` holds only a `PlatformPort` and cannot reach the cache (§3). So
`clearSession`, `forgetSession` and `removeAccount` do not touch it, and **the caller must
sequence `itemCache.clearItemCache(accountId)` alongside them**. Leaving an encrypted cache
on disk after its keys are gone is a real leak.

Note that lock is deliberately not sign-out:

| call | `session_data` | quick-unlock afterwards |
| --- | --- | --- |
| `clearSession` | kept | yes |
| `forgetSession` | deleted | no |

### 4.3 `getUnlockedAccounts` means "MUK is in memory"

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
- Record locations are published as fully-resolved `itemsKeyPrefix` / `vaultsKeyPrefix`,
  built from `PlatformPort.recordKeyPrefix` (`"record:"` on desktop, `""` elsewhere), so the
  host does a pure prefix scan and concatenates nothing.

**`NATIVE_VIEW_VERSION` is 2, and bumping it is a coordinated change.** The Rust parser
checks `v` before interpreting any other field. A desktop binary and a JS bundle that
disagree refuse each other's view and report zero accounts — the intended failure mode, but
it means both must ship together.
