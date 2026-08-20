# Adversarial review of the greenfield decision corpus

Produced by a subagent during the Wayfinder charting session, 2026-08-20.
Target: `docs/greenfield/` as it stood at commit `f105c7d3`.
Status: evidence. Findings are folded into the decision tickets that own them; nothing here is a decision.

## Critical

### The corpus asserts zero knowledge before it defines what the Server is allowed to learn
**Attacks:** `PROD-FOUNDATION-003`, `ITEM-003`, `ADMIN-001`, `AUDIT-001`; `grilling/README.md` session order item 1

`PROD-FOUNDATION-003 MUST` promises "preserving zero knowledge against its administrator" and `ADMIN-001 MUST` says administrators "cannot decrypt, impersonate Users, reset cryptographic secrets, or enroll a replacement Device silently" — yet the threat-model session that would define those words has not happened. `ITEM-003` enumerates what is encrypted and stops. Nothing anywhere enumerates the plaintext the Server necessarily holds: Item and Vault identifiers, ciphertext length, revision counters, create/modify timestamps, the per-Vault access graph, the Sync event stream, tombstones, Attachment counts and sizes, Share-link existence, and `AUDIT-001`'s records. `AUDIT-001`'s word "privacy-conscious" is the only constraint on the richest metadata source in the system, and it is not a testable predicate. An administrator with that plaintext learns who shares what with whom, when each secret was created and last rotated, and roughly how large each one is.

**Why it matters:** Two implementers will draw the ciphertext boundary in different places, and neither build can be shown to violate a requirement, so the product's headline claim becomes unfalsifiable.

**Suggested resolution:** Should there be a `PRIVACY-*` requirement family that enumerates the exact server-visible plaintext field set as a closed list, with anything not on the list required to be encrypted, and does `AUDIT-001` record actor and object identifiers in plaintext or only as ciphertext the operator cannot read?

### The Web client's zero knowledge depends on trusting whoever served it, and the corpus never requires TLS
**Attacks:** `ADMIN-001` against `HOST-003`, `HOST-001`, `ACCOUNT-001`

`HOST-003 MUST` says "The Server serves its matching Web client by default." For that client, `ADMIN-001`'s "cannot decrypt" is false by construction: the administrator ships the JavaScript and WASM that handle the master password, so decryption is one deploy away. `ACCOUNT-001 MUST` makes it worse — the operator of the server that served the page controls the code that handles vault keys belonging to *other* servers. Separately, `HOST-001 MUST` makes LAN-only deployments first-class, and no requirement in the corpus mandates TLS or a secure context (no occurrence of TLS, HTTPS, certificate, or origin in any target document). Over `http://192.168.x.x` the browser withholds `crypto.subtle`, Service Workers, OPFS, and WebAuthn, which kills the OPFS investigation in `ARCH-STORE-001` and the WebAuthn PRF path in `open-questions.md`, and any LAN attacker can substitute the client bundle.

**Why it matters:** The strongest security claim in the product is materially weaker on the platform most users meet first, and the corpus does not say so anywhere.

**Suggested resolution:** Does a `HOST-*` requirement mandate an authenticated transport as a precondition for the Web client, and does the product state in requirements and in the UI that the Web client's guarantee is per-load trust in its serving operator?

### Recovery Key and Emergency Kit quietly collapse AUTH-001's two-factor claim, and "revocable" is a promise the design cannot keep
**Attacks:** `AUTH-001`, `AUTH-004`, `AUTH-006`, `AUTH-005`

`AUTH-001 MUST` states "Master password and high-entropy Secret Key jointly protect account encryption." `AUTH-006 MUST` keeps Recovery Keys "capable of changing the master password without Server decryption", which in the frozen design (`legacy/CONTEXT.md`: Recovery key is "A separately generated key (`R1-...`) holding a second wrapping of the master key") means one artifact alone unwraps everything. `AUTH-004 MUST` then names "Emergency Kit recovery" as a device-enrollment path, and the Emergency Kit is the document holding both the Secret Key and Recovery Key: a single printable page that defeats the joint protection `AUTH-001` asserts. The corpus never states this exception. `AUTH-006`'s "revocable" is also unenforceable: revoking a Recovery Key deletes a server-held wrapped blob, but an administrator's backup (`HOST-004`) of that blob plus the old Recovery Key still opens the account unless every vault key is rotated.

**Why it matters:** An implementer reading `AUTH-001` will design and market a two-secret system while shipping three single-secret bypasses.

**Suggested resolution:** Does `AUTH-001` get an explicit exception clause naming every single-artifact recovery path, and does `AUTH-006` "revocable" mean delete-the-wrapper-only stated as best-effort, or mandatory master-unlock-key and vault-key rotation on revocation?

### Vault key rotation is load-bearing everywhere and specified nowhere
**Attacks:** `TEAM-004`, `ATTACH-001`, `AUTH-006`, `VAULT-001`, `scenarios/README.md` seed 7, `feature-disposition.md`

`TEAM-004 MUST` is the only mention of rotation in the entire target corpus. No `VAULT-*` requirement says rotation exists, what it re-encrypts, how key epochs are represented, who may initiate it, or what happens under failure. `feature-disposition.md` never assigns a disposition to Vault key rotation or Rotation plans, even though the current-state catalog records them as Observed and the frozen product has an ADR for the mechanism. The unaddressed hard case is the intersection with `SYNC-001`: a Device offline during rotation holds durably-accepted edits sealed under epoch N, and `ITEM-004`'s Conflict-copy rule does not help, because the problem is unreadability, not divergence. Seed scenario 7 covers write-blocking and not one word of re-sealing.

**Why it matters:** Rotation is the only mechanism that makes departure, Recovery-Key revocation, and Attachment-key revocation mean anything. It is the single most expensive subsystem to retrofit.

**Suggested resolution:** What is the `VAULT-ROTATION-*` requirement set, and specifically: do Items carry an explicit key epoch, and does a queued offline operation sealed under a superseded epoch get re-sealed by the engine, rejected to the user, or converted to a Conflict copy?

## Significant

### SYNC-001's durability MUST is not achievable on the storage the architecture picks for Web and extension
**Attacks:** `SYNC-001`, `ARCH-STORE-001`; seed scenarios 1 and 10

`SYNC-001 MUST` requires that local durable acceptance precede network synchronization, and `ARCH-STORE-001 MUST` says Web and extension "start with a transactional browser-store adapter; SQLite/OPFS remains an investigation, not a requirement." Browser storage does not offer SQLite's durability contract: IndexedDB is subject to quota eviction and "Clear site data", an MV3 service worker is terminated on roughly 30s idle mid-transaction, Safari caps script-writable storage for low-interaction sites, and every transaction from the Rust/WASM worker must round-trip through JS. Seeds 1 and 10 are therefore fixtures the native hosts will pass and the browser hosts may not, contradicting `ARCH-STORE-001`'s own promise that the fixtures are shared.

**Why it matters:** A password manager that silently loses an offline edit, or loses the whole replica to an eviction event, is a data-loss product.

**Suggested resolution:** Does `ARCH-STORE-001` state an explicit weaker durability class for browser hosts with a matching honesty clause, or does the outbox require a durability floor (persistent-storage permission, OPFS, or unsynced-work-blocks-shutdown) that promotes OPFS from investigation to requirement?

### Encrypted URLs plus offline autofill implies a search index nobody has specified
**Attacks:** `ITEM-003` against `OFFLINE-001`; `TRAVEL-001`; `ARCH-STORE-001`

`ITEM-003 MUST` encrypts titles, URLs/domains, tags and Favorite, and `OFFLINE-001 MUST` requires browse, search and autofill to work offline. Domain-matched autofill must therefore evaluate every Item's URL set on every page load, against a store that cannot index the ciphertext. The only acknowledgement is one word inside `TRAVEL-001` ("evicts disallowed Vault ciphertext, indexes, and accessible keys"), which presumes an index that no requirement creates or constrains. Nobody has decided whether the index is memory-only (paying a full decrypt on every unlock, against an unspecified unlock-to-list budget) or persisted encrypted (and if so, whether its structure leaks domain names, term frequencies, or Item counts). `open-questions.md` frames this as an ergonomics question rather than a leakage question.

**Why it matters:** Persisted search indexes are the classic place where a zero-knowledge design leaks, and the memory-only alternative is the classic place where large-vault unlock latency becomes unfixable.

**Suggested resolution:** Is the search/autofill index memory-only and rebuilt at unlock, or persisted and encrypted, and if persisted, which requirement bounds what an attacker with the file learns?

### Offline optimistic acceptance meets server-side authorization with no defined losing path
**Attacks:** `SYNC-001`, `SYNC-004` against `TEAM-004`, `AUTH-008`, `ADMIN-001`, `OFFLINE-003`

`SYNC-001 MUST` durably accepts local mutations before the network sees them, but every authorization decision is made by the Server. `SYNC-004 MUST` provides a "rejected" state and no requirement says what the user sees or keeps when a durably-accepted, locally-visible edit is permanently rejected for authorization reasons. This widens under `OFFLINE-003`, which is only a `SHOULD` and explicitly permits indefinite offline access: a conformant build can ship with no revalidation window at all, so `AUTH-008` revocation and `ADMIN-001` suspension become unenforceable by design against exactly the device they are aimed at. There is no seed scenario for "user writes offline for 30 days after their access was revoked."

**Why it matters:** Either the user loses work with no explanation, or the client silently keeps writes it has no right to make.

**Suggested resolution:** When a durably-accepted local operation is rejected for authorization, does the engine preserve it as a local-only artifact the user can copy out, discard it with an audit entry, or convert it to a Conflict copy, and should `OFFLINE-003` become a `MUST` with a mandatory maximum window?

### The credential-provider process needs the unlock key that ARCH-STORE-002 forbids storing
**Attacks:** `ARCH-ENGINE-002` against `ARCH-STORE-002`; `feature-disposition.md` row "Android TypeScript credential projection/key bridge"

`ARCH-ENGINE-002 MUST` says OS-mandated credential-provider processes "use constrained runtimes and an explicit shared-store locking/protocol design", and `ARCH-STORE-002 MUST` says the Device Unlock Wrapper "never stores the master unlock key as an ordinary retrievable value." An Android Credential Manager provider or an iOS AutoFill extension is a separate process, launched by the OS, that must decrypt Vault ciphertext with no main app running. It therefore needs either the unlock key or an equivalent capability. The frozen product hit exactly this wall. `feature-disposition.md` disposes of the bridge as "Replace | Native constrained runtime and shared encrypted replica" without saying how the second process obtains keys: that phrase names the ciphertext problem and skips the key problem.

**Why it matters:** This is where the previous implementation's security model actually broke, and the replacement re-inherits it under a new name.

**Suggested resolution:** Does the credential-provider process hold its own OS-gated wrapper with a narrower key (per-Vault or autofill-scoped), or obtain keys by IPC from the main runtime, and which requirement states the reduced guarantee that results?

### Server restore rolls back everything the security model treats as irreversible
**Attacks:** `HOST-004` against `ITEM-006`, `AUTH-008`, `AUDIT-001`, `SHARE-002`, `ADMIN-001`

`HOST-004 MUST` requires a backup of database state, Attachments, Server identity and authentication secrets with automated restore, and never says the archive must be encrypted or that restore must be rollback-detectable. `ITEM-006 MUST` builds tombstones that prevent old offline Devices from resurrecting deleted Items, but an administrator restoring last month's backup resurrects deleted Items, revoked sessions, revoked Share links, and superseded key epochs, and no requirement or scenario covers it. The same restore rewrites `AUDIT-001`'s history, so the audit log is not tamper-evident against the one actor `ADMIN-001` is written to constrain. Seed scenario 12 tests the happy path, not the abuse path.

**Why it matters:** Zero knowledge is defended in depth against the administrator, and then an ordinary supported operation gives that administrator a time machine over authorization state with no client-visible signal.

**Suggested resolution:** Must clients detect server rollback (monotonic server epoch, signed cursor, or client-pinned high-water mark) and refuse or warn, and must `HOST-004` require the backup archive to be encrypted with operator-held material distinct from the running Server's secrets?

### Nothing in the corpus defends the password against online guessing, which is exactly what OPAQUE requires
**Attacks:** `AUTH-003`, `AUTH-001`, `AUTH-002`; absent from both `open-questions.md` and the `feature-disposition.md` Unclassified list

OPAQUE's security argument removes offline pre-computation against a stolen database but leaves online guessing wide open, so rate limiting, backoff and lockout are load-bearing rather than optional. The corpus contains no requirement about rate limiting, lockout, abuse defense, or enumeration resistance on any endpoint. Second, `AUTH-002 MUST` domain-separates password authentication from Vault-key derivation, which means the client runs two expensive KDFs on every full sign-in, on the platforms with the least CPU. Third, the frozen product's KDF-profile pinning (`legacy/CONTEXT.md`: "The client pins them after first use so they can never be silently weakened") has no successor requirement; `open-questions.md` mentions profile upgrades and never mentions downgrade resistance. Fourth, the stated benefit of OPAQUE is largely already delivered by `AUTH-001`'s Secret Key, which makes a stolen server database useless regardless of protocol, so the corpus is buying its hardest, least-reviewable component for a marginal gain with no named fallback if the `AUTH-003` conformance gate fails.

**Why it matters:** The build can ship a formally elegant PAKE and still lose accounts to a scripted guessing loop, or to a malicious server declaring Argon2 parameters of 1 iteration.

**Suggested resolution:** What `AUTH-*` requirement mandates per-account and per-IP throttling with lockout semantics, what requirement forbids silent KDF-parameter weakening, and what is the named fallback protocol if OPAQUE misses its gate?

## Worth a look

### A third party's beta schedule is a release gate for the least security-critical layer
**Attacks:** `target/architecture.md` "Browser TypeScript and Effect"; `decisions/0001`; `open-questions.md`

The same section says Effect "does not own Vault policy, session state, replica/search, durable retries, Sync scheduling, conflict handling, or canonical domain schemas": it owns clipboard, file picker, Worker lifecycle and visibility. The corpus makes shipping the whole product conditional on a dependency reaching stable, for a layer scoped to the most replaceable code in the tree, while the migration strategy across pre-stable versions is still an open question. The gate also has no requirement ID, so it appears in no traceability chain and no CI check can enforce it.

**Why it matters:** A release gate on a third party's timeline is real schedule risk for a layer that could be hand-written for a fraction of the migration cost, and an unenforceable gate quietly gets dropped.

**Suggested resolution:** Is the gate "Effect v4 is stable" or "the platform layer has no pre-stable dependency", and if the latter, does the Web host fall back to hand-written adapters rather than blocking the release?

### The implementation gate as written forbids starting, which means it will be ignored
**Attacks:** `README.md` "Implementation gate" items 1, 2 and 6, against `feature-disposition.md` Unclassified, `scenarios/README.md`, `traceability.md`

The gate requires that every current capability has a disposition, every security-critical scenario is resolved, and every `MUST` requirement has a traceable acceptance scenario. Today the Unclassified list holds eleven whole families including import/export and device management, all twelve seed scenarios remain OPEN by their own text, and `traceability.md` has six rows with every Test column reading OPEN. Meanwhile the scope is five client surfaces, a Rust engine, a Rust server, and a conformance corpus executed four ways. Two related product cliffs sit inside the Unclassified list: import/export is the only bridge for existing users, because `PROD-FOUNDATION-005` guarantees the rebuild need not open current Accounts, ciphertext, Attachments, databases or protocols.

**Why it matters:** An all-or-nothing gate in front of a seventeen-session specification and a seven-target build either freezes the project or gets quietly overridden, and an overridden gate stops constraining anything.

**Suggested resolution:** Should the gate become per-slice (a subsystem may be implemented when its own dispositions, scenarios and formats are accepted), which client surfaces are in the first release, and does import/export move out of Unclassified into the first release?
