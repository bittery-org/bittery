# Candidate greenfield product target

Status: **Candidate**.

## Product position

`PROD-FOUNDATION-001 MUST` Bittery is fully open source and self-hosted. Bittery operates no hosted
cloud product.

`PROD-FOUNDATION-002 MUST` Normal enrollment and synchronization require a Server. Once initialized,
ordinary Vault use remains offline-first.

`PROD-FOUNDATION-003 MUST` A deployment supports multiple Users and Teams while preserving zero
knowledge against its administrator.

`PROD-FOUNDATION-004 MUST` Billing, plans, subscriptions, Stripe, commercial entitlements, and
hosted-cloud operational branches are absent from the product.

`PROD-FOUNDATION-005 MUST` The rebuild is a clean product reset. It need not open current Accounts,
ciphertext, Attachments, databases, or protocols.

## Threat model and privacy

`PRIVACY-001 MUST` The product names seven adversary classes: Curious Operator, Malicious Operator,
Network Attacker, Device Thief, Co-tenant User, Vault Co-member, and Compromised Client Build. Every
security requirement states which class it answers. A Vault Co-member is a legitimate member of a
Vault, acting outside their remit; `CRYPTO-005` and `CRYPTO-012` are the controls that answer them, by
making a Vault grant and an Item revision provably authored rather than merely claimed.

`PRIVACY-002 MUST` Each attack available to a Malicious Operator is classed Prevented, Detectable, or
Acknowledged. A Prevented attack cannot succeed. A Detectable attack is reported to the User by their
own client. An Acknowledged attack is stated in product documentation and not defended against.

`PRIVACY-003 MUST` A Malicious Operator cannot read Item content, and cannot forge a Vault grant that
a client accepts. A member holding the Vault key grants access by sealing that key to the recipient
and signing the grant, which `CRYPTO-005` specifies. A Server authorization record never grants
access. Server-side access control is an availability and abuse control only.

`PRIVACY-004 MUST` Five Malicious Operator attacks are Detectable. Enrolling a Device without every
existing Device of that Account being told. Presenting Vault membership that no member signed.
Replaying Server state older than a client already accepted. Dropping an Item revision, which a
per-Item revision chain exposes. Serving every User a Web client bundle that is not the published
release, which `PRIVACY-016` makes checkable by any third party.

Two attacks that would otherwise sit on this list are Prevented instead, because `CRYPTO-009` binds an
object's identity into the additional authenticated data of its envelope: moving ciphertext from one
Item to another, and serving one revision of an Item in place of a different one. Both fail to
decrypt rather than being noticed afterwards.

`PRIVACY-005 MUST` Five attacks are Acknowledged. Denial of service. Withholding data from a client.
Server equivocation between two Devices of one Account. Every field on the `PRIVACY-007` list.
Serving a substituted Web client bundle to a single targeted User, which `PRIVACY-015` states plainly.

`PRIVACY-006 MUST` `PRIVACY-007` is a closed list. Any field the Server holds in plaintext that
`PRIVACY-007` does not name is a defect. A repository check fails on any plaintext Server schema
column absent from the list.

`PRIVACY-007 MUST` Server-visible plaintext is exactly:

- **Account** — identifier, email address, status, password-authentication record, public keys,
  wrapped Account Key Set. The wrapped Account Key Set is served only after a full sign-in succeeds.
- **Device** — identifier, user-chosen name, public key, enrollment sequence number.
- **Vault and Team** — identifier, name, owning User or Team, membership with role, wrapped Vault
  keys each with its granter Account identifier and grant signature, wrapped Team History Key per
  reader, current key epoch.
- **Item** — identifier, owning Vault, ciphertext, ciphertext length, revision sequence number,
  revision chain hash, tombstone marker, day-resolution retention bucket.
- **Attachment** — identifier, owning Item, chunk count, total byte size, wrapped Attachment key.
- **Share link** — identifier, expiry, view count, maximum views, ciphertext, ciphertext length.
- **Sync** — per-Vault sequence stream carrying Item identifier and operation kind.
- **Operator Log** — Account identifier, event category, sequence number, source address, byte counts.
- **Quota** — Item count per Vault, stored byte count per Account.

`PRIVACY-008 MUST` The Server holds no wall-clock creation or modification time for an Item, a Vault,
or an Attachment. Ordering uses per-Vault sequence numbers. Real times are sealed inside ciphertext.
Retention uses the day-resolution bucket that `PRIVACY-007` names.

`PRIVACY-009 MUST` Ciphertext is not padded. Ciphertext length is Server-visible.

`PRIVACY-010 MUST` A Share link is unlinkable. The Server does not learn which Item a Share link was
created from.

`PRIVACY-011 MUST` A Co-tenant User learns nothing about a Vault they are not a member of, including
its existence, and nothing about a User they share no Team with. Invitation address lookup is the
sole exception.

`PRIVACY-012 MUST` Released client builds are reproducible and their signatures are published, so a
substituted build is Detectable by a third party. The product never claims that a running client
detects its own compromise. `PRIVACY-016` extends this to the Web client bundle, which is re-fetched
on every load rather than installed once.

`PRIVACY-013 MUST` Product documentation states the `PRIVACY-007` list in plain language, naming Vault
names, Team names, Device names, email addresses, and the Vault membership graph as readable by the
operator.

`PRIVACY-014 MUST` Server request logs carry a documented default retention bound. Unbounded request
logging reintroduces the wall-clock history that `PRIVACY-008` removes.

`PRIVACY-015 MUST` The Web client's guarantee is per-load trust in its serving operator. That operator
ships the code that handles the master password on every load, and can serve different code to one
User. `ADMIN-001`'s Prevented verbs therefore describe installed clients; on the Web client the same
operator attack is Acknowledged. Product documentation states this. Matching `PRIVACY-013`, no in-app
screen and no signup interstitial states it.

`PRIVACY-016 MUST` Each release publishes the content hash of its Web client bundle alongside the
`PRIVACY-012` signatures. A Server serves the byte-exact published bundle for the version it declares,
and exposes the served bundle's hash at a documented well-known path. A substitution served to every
User is therefore Detectable by a third party. A substitution served to one User stays Acknowledged.

## Self-hosting

`HOST-001 MUST` LAN-only, public internet, and private-overlay deployments are first-class.

`HOST-002 MUST` Official deployment includes a simple single-node profile and a scalable profile.
Both use identical application semantics. Redis is not required for correctness.

`HOST-003 MUST` The Server serves its matching Web client by default.

`HOST-004 MUST` A supported backup command creates a consistent archive of database state,
Attachments, Server identity, and authentication secrets. Restore is automated and tested.

`HOST-005 MUST` Email is optional. Essential enrollment and recovery cannot depend exclusively on
SMTP.

`HOST-006 MUST` No client or Server contacts an external service by default. Every integration is
separately enabled and documents its disclosure.

`HOST-007 MUST` The Web client is served only from a secure context. A Server refuses to serve the Web
client over a non-secure origin and returns a page stating the requirement. A non-secure origin
withholds `crypto.subtle`, the Origin Private File System, Service Workers, the Cache API, and
`StorageManager.persist()`, so the Web client cannot meet its storage and cryptographic obligations
there. `http://localhost` and `127.0.0.0/8` are secure contexts; RFC 1918 addresses and `*.local`
names are not. This answers the Network Attacker class.

`HOST-008 MUST` The product ships no certificate authority, no certificate generation, and no
certificate renewal. Documentation gives a supported route to a secure context for each `HOST-001`
deployment shape: a private overlay network that issues publicly-trusted certificates for its own
names, a publicly-trusted certificate for an internet-reachable name, an operator-supplied private
certificate authority, and a loopback forward for single-machine use.

`HOST-009 MUST` A Server serves the Web client under exactly this Content Security Policy:

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'; object-src 'none'
```

`'wasm-unsafe-eval'` is required or the engine cannot instantiate. `'unsafe-inline'` and
`'unsafe-eval'` are defects, so every style and script is external or hashed. `connect-src 'self'` is
achievable only because `ACCOUNT-001` binds the Web client to its serving Server.

## Administration and registration

`ADMIN-001 MUST` Administrators control admission, suspension, quotas, retention, and deletion of
encrypted server data. They cannot decrypt or impersonate Users, and cannot reset cryptographic
secrets. Enrolling a replacement Device is Detectable, not Prevented. `PRIVACY-002` defines these
words, and `PRIVACY-007` bounds what an administrator sees. These Prevented verbs describe installed
clients. On the Web client, `PRIVACY-015` downgrades "cannot decrypt" to Acknowledged, because the
administrator serves the code that handles the master password.

`ADMIN-002 MUST` Registration supports configurable open, invitation-only, and closed modes.
Administrator-created enrollment is an invitation; administrators never choose user secrets.

## Accounts, Servers, and unified use

`ACCOUNT-001 MUST` One installed client can configure Accounts from several independent Servers. An
installed client is a released, signed Desktop or Extension build. The Web client configures only
Accounts of the Server that served it, one or many, because a page served by Server A must never hold
Server B's Vault keys.

`ACCOUNT-002 MUST` Local Account identity is scoped by stable Server identity and User identity, not
email or URL alone.

`ACCOUNT-003 MUST` The active scope may be one Account, one local Collection, or All Accounts. Local
Collections and All Accounts are installed-client scopes; the Web client's widest scope is the Server
that served it.

`ACCOUNT-004 MUST` Browse, search, Favorites, recent Items, autofill, and Sentinel follow the active
scope. Aggregated results expose their Vault and Account/Server provenance.

`ACCOUNT-005 MUST` Trash, Settings, Teams, and administration remain Account-scoped.

`ACCOUNT-006 MUST` A Collection is a local filtering construct over Vaults. It owns no data, keys, or
membership and may span Servers.

`ACCOUNT-007 MUST` Cross-Account transfer is copy followed by separately confirmed source deletion.
The product never claims cross-Server atomic movement.

## Authentication, recovery, and Devices

`AUTH-001 MUST` Master password and high-entropy Secret Key jointly protect account encryption.

`AUTH-002 MUST` Password authentication and Vault-key derivation are domain-separated systems.

`AUTH-003 MUST` A full sign-in is a signature challenge-response. Argon2id runs over the master
password, HKDF-Extract mixes in the Secret Key, and HKDF-Expand under an authentication label produces
the 32-byte seed of an Ed25519 Authentication Key. The Server stores the 32-byte public key and no other
password-derived value. No password-derived secret ever reaches the Server, at rest or on the wire. A
second HKDF-Expand label over the same Argon2id run produces the Vault-unlock material, and those
labels are what satisfy `AUTH-002`; `AUTH-015` fixes the single-run rule. ADR 0006 records why
OPAQUE, SRP-6a, and an authentication hash were rejected.

`AUTH-009 MUST` The signed message is canonical and length-prefixed, and binds a purpose label, the
protocol version, the Server identity, the Account identifier, and a single-use Sign-in Challenge issued
by the Server. Binding the Server identity is what stops a hostile Server relaying a challenge from
another Server, which `ACCOUNT-001` makes a live case for installed clients.

`AUTH-010 MUST` The authentication salt derives from the Secret Key on the client. The Server stores no
salt, sends no salt, and exposes no endpoint that reveals whether an Account exists before a full sign-in
begins. Key-derivation parameters are Server-wide and published in the Server descriptor, not per
Account, so no Device can be handed weaker parameters than another. The key-derivation profile
identifier is held in Device state and printed on the Emergency Kit. ADR 0007.

`AUTH-011 MUST` The full sign-in protocol authenticates Device enrolment and full sign-in only. An
enrolled Device authenticates ordinary traffic with its Device credential. Every surface uses the same
protocol and the same Server endpoint, including the Web client, so no weaker authentication path exists
to steer a client onto.

`AUTH-012 MUST` The construction ships with a written design note and conformance test vectors. The
vectors enter the conformance fixture corpus, proving the Rust core, the WASM build, and the Server
produce and verify byte-identical results.

`AUTH-013 MUST` An external cryptographic review of the design note is a gate before general
availability, and precedes any penetration test of the running system. Beta release ahead of that review
is permitted. Product documentation states that the authentication protocol is a bespoke construction
pending external review, following the documentation-only disclosure rule `PRIVACY-013` sets.

`AUTH-014 MUST` The authentication protocol version is rotatable without touching Vault data. Publishing
a new version, having each client re-derive and re-register its Authentication Key at next full sign-in,
and refusing the superseded version at the Server is a specified path, not an implied one. No Vault data
moves and nothing is decrypted.

`AUTH-015 MUST` A full sign-in performs exactly one memory-hard run. Argon2id runs once over the
master password, HKDF-Extract mixes in the Secret Key, and HKDF-Expand under distinct labels produces
the Authentication Key seed and the Vault-unlock material. Those labels are the domain separation
`AUTH-002` requires; a second Argon2id run would add no entropy, no new secret, and no independence,
and would double the cost on browser WASM, which is the weakest supported build. ADR 0008.

`AUTH-016 MUST` The first key-derivation profile is Argon2id version `0x13` with 64 MiB of memory,
3 passes, 1 lane, a 16-byte salt, and a 32-byte output. One lane, because a browser Worker is
single-threaded unless the operator sets cross-origin isolation headers, and more lanes would give a
single-threaded build no speedup while covering less memory per lane. Argon2id's optional secret
parameter is unused. The salt is HKDF-Expand output derived from the Secret Key under a label that
carries the profile identifier, and binds nothing else, so no life event and no operator change can
silently invalidate a key. Parameters are the normative contract; the product states no wall-clock
budget. A measurement on the weakest supported build is recorded in the design note `AUTH-012`
requires before a registry entry is frozen.

`AUTH-017 MUST` Key-derivation profiles are a closed, ordered, append-only registry compiled into
every client. A Server descriptor names one entry and publishes no parameters. A client refuses an
identifier it does not hold, reporting that the client needs updating, and never derives under
parameters a Server supplies. No entry is ever removed or altered, because the pinned profile is the
only route to an Account's Vault keys and retiring one would permanently lock out every Account still
on it. ADR 0009.

`AUTH-018 MUST` An Account is pinned to the profile it was created under, and a client derives under
the pinned profile whatever a Server publishes. Where the published profile is stronger, the client
offers an upgrade at the end of a full sign-in, while the master password is still in hand; the User
may decline and is offered it again. An upgrade re-derives both HKDF outputs and re-wraps what the
Vault-unlock material protects, which is the master password change path and not a new mechanism.
Where the published profile is weaker than the pinned one, the client derives under the pinned profile
and records the divergence in Security History. A downgrade attempt is Detectable.

`AUTH-019 MUST` A Device holding no local state learns the pinned profile from the Emergency Kit,
which prints it, or by attempting the published profile and then each older registry entry in
descending order. A Server exposes no endpoint that returns an Account's profile and stores no
per-Account profile, so this requirement adds nothing to the `PRIVACY-007` plaintext allowlist. The
cost is one derivation per attempt, so a genuinely wrong password is reported only after the walk
completes.

`AUTH-020 MUST` The memory-hard step governs every derivation path that consumes a user-chosen
secret, recovery included. A path uses HKDF alone only where every secret it consumes is
machine-generated with at least 128 bits of entropy, which is why the Secret Key is not stretched. No
path derives under a profile weaker than the Account's pinned profile, and no path carries its own
parameters. ADR 0008.

`AUTH-021 MUST` The master password is encoded as UTF-8 after NFKD normalization, with no trimming of
leading or trailing whitespace, no case folding, and an empty password refused. Its minimum length is
10 characters and no composition rule is imposed. The client shows an advisory strength estimate and
offers a generated passphrase; the estimate never blocks. A Server cannot enforce master password
policy, because no Server ever sees a master password, so an administrator has no lever here.

`AUTH-004 MUST` Adding a Device supports trusted-device QR enrollment, master password plus Secret Key,
and Emergency Kit recovery. The Server alone cannot provision decryption keys.

`AUTH-005 MUST` Losing all trusted Devices, Secret Keys, and Recovery material is unrecoverable by an
administrator.

`AUTH-006 MUST` Optional Recovery Keys remain user-held, rotatable, revocable, and capable of changing
the master password without Server decryption.

`AUTH-007 MUST` Biometrics provide local authorization to use device-bound wrapping capability. They
are not Server authentication or recovery credentials.

`AUTH-008 MUST` Revocation takes effect when an offline Device reconnects. The product never claims
remote erasure of a Device that never reconnects.

## Cryptographic format

`CRYPTO-001 MUST` The key hierarchy is fixed and has exactly these levels. `AUTH-015`'s single
Argon2id run and HKDF-Expand produce the **Account Unlock Key**. That key wraps the **Account Key
Set**. The Account Key Set's encryption key receives sealed **Vault keys** and the sealed **Team
History Key**. A Vault key encrypts Item revisions directly and wraps **Attachment keys**. An
Attachment key encrypts that Attachment's chunks. No other level exists, and no key wraps a key that
this requirement does not name.

`CRYPTO-002 MUST` The Account Key Set is an X25519 encryption key pair and an Ed25519 **Account
Signing Key** pair, both generated from a cryptographic random source at Account creation and never
derived from the master password. It is stored as one envelope wrapped by the Account Unlock Key, and
a Server serves it only after a full sign-in succeeds, never before, so `AUTH-010`'s no-enumeration
rule holds. Because the Account Key Set is random rather than derived, a master password change, a
Secret Key rotation, and an `AUTH-018` profile upgrade re-wrap one envelope and leave every Vault key
and every existing grant untouched.

`CRYPTO-003 MUST` XChaCha20-Poly1305 is the only authenticated encryption algorithm in the product,
for content and for key wrapping alike, with a 192-bit nonce drawn from a cryptographic random source
for every message. A counter-based nonce is impossible here: Devices write offline under one Vault key
and reconcile later, so a coordinated sequence cannot exist. A 96-bit random nonce would place the
birthday bound near 2^32 messages under a key that covers every Item, every revision, and every
Attachment chunk for the life of a Vault.

`CRYPTO-004 MUST` A Vault key or a Team History Key is sealed to a recipient's X25519 encryption key
using HPKE (RFC 9180) in **export-only** mode, suite `DHKEM(X25519, HKDF-SHA256)` with `HKDF-SHA256`
and AEAD identifier `0xFFFF`. The HPKE context exports a 32-byte key and a 24-byte nonce, which feed
the `CRYPTO-003` envelope. Export-only mode is what keeps the product at one AEAD, because RFC 9180
registers no XChaCha20-Poly1305 suite. The exported nonce is not transmitted. RSA is absent from the
product.

`CRYPTO-005 MUST` A Vault grant carries an Ed25519 signature by the granting member's Account Signing
Key over a canonical, length-prefixed message binding a purpose label, the format version, the Server
identity, the Vault identifier, the key epoch, the granter's Account identifier, the recipient's
Account identifier, the recipient's Account Fingerprint, and the granted role. A client accepts no
grant whose signature does not verify, which is what makes `PRIVACY-004`'s unsigned-membership attack
Detectable. The Account Signing Key is distinct from the `AUTH-003` Authentication Key, because
`AUTH-014` rotates the Authentication Key without touching Vault data and a shared key would orphan
every past grant on rotation.

`CRYPTO-006 MUST` Vault grants are flat. Every Vault key is sealed straight to each member's Account
encryption key, and no key opens more Vaults than its holder was granted. A Team owns one **Team
History Key**, sealed to each reader, which protects that Team's Security History and nothing else. A
Team key that wrapped Vault keys would contradict `TEAM-003`, by making every member a decryptor of
every Team Vault, and `TEAM-004`, by making one departure rotate every Vault the Team owns.

`CRYPTO-007 MUST` A single **format version** byte identifies the whole cryptographic suite, indexing
a closed, ordered, append-only registry compiled into every client. The registry entry names the AEAD,
the KEM, the KDF, the signature algorithm, the hash, and the byte layout together. There is no
negotiation, no per-field algorithm agility, and no field a Server can influence, so the format has no
downgrade surface. An unknown version is a hard refusal reporting that the client needs updating.
Version `0x01` is XChaCha20-Poly1305, HPKE export-only over `DHKEM(X25519, HKDF-SHA256)`, Ed25519, and
SHA-256. This registry is separate from the `AUTH-017` key-derivation profile registry and governed
the same way. ADR 0010.

`CRYPTO-008 MUST` Every persisted ciphertext is one envelope in one of two shapes, chosen by its key
context byte, with all integers big-endian:

- **Symmetric**: format version `u8`, key context `u8`, key epoch `u32`, 24-byte nonce, then
  ciphertext followed by the 16-byte tag. The header is 30 bytes.
- **Sealed**: format version `u8`, key context `u8`, key epoch `u32`, the 32-byte HPKE encapsulated
  key, then ciphertext followed by the 16-byte tag. The header is 38 bytes, because `CRYPTO-004`
  exports the nonce rather than transmitting it.

The key epoch is present in every envelope and MUST be zero in a key context that has no epochs. It is
how `CRYPTO-001`'s decoder selects a Vault key generation, which is what makes the lazy rotation in
the Vault key epoch work possible.

`CRYPTO-009 MUST` The additional authenticated data of every envelope is the header bytes verbatim,
followed by a binding tuple the decoder **reconstructs from where it found the blob**, each field
`u16` length-prefixed in a fixed per-context order: Vault identifier and Item identifier and revision
number for an Item revision, Attachment identifier and chunk index and total chunk count for a chunk,
and so on. Moving ciphertext between Items, or serving one revision in place of another, therefore
fails to decrypt rather than succeeding silently, which raises those attacks from Detectable to
Prevented. No component may hand the cryptographic layer a blob without its context. A Share link
snapshot binds the Share link identifier and never the source Item identifier, or `PRIVACY-010`
unlinkability would fail.

`CRYPTO-010 MUST` Key contexts are a closed table, and the byte selects the envelope shape:
`0x00` reserved and never valid; `0x01` Account Key Set under the Account Unlock Key; `0x02` Account
Key Set under a Recovery Key; `0x03` Account Key Set under a Device Unlock Wrapper key; `0x10` Vault
key sealed to an Account encryption key; `0x11` Team History Key sealed to an Account encryption key;
`0x20` Item revision under a Vault key; `0x21` Attachment key under a Vault key; `0x22` Attachment
chunk under an Attachment key; `0x30` Security History under a User History Key; `0x31` Security
History under a Team History Key; `0x40` Share link snapshot under a Share link key. The context byte
is plaintext and adds nothing to `PRIVACY-007`, because the Server already knows which table it read a
blob from.

`CRYPTO-011 MUST` A key that protects data is generated randomly; an HKDF label exists only where a
key is derived from a secret that already exists. The label registry is closed and its members are the
ASCII byte strings `bittery/1/kdf-salt/1`, `bittery/1/auth-key/1`, `bittery/1/account-unlock`,
`bittery/1/recovery-unlock`, `bittery/1/device-unlock`, `bittery/1/share-link`, and
`bittery/1/search-index`, used verbatim as HKDF-Expand `info` with no terminator. The key-derivation
profile identifier rides in the salt label per `AUTH-016`, and the authentication protocol version
rides in the authentication label, so `AUTH-014` rotation is a label change and nothing more. A
repository check asserts the table is pairwise distinct, because a collision would make two keys equal
and nothing else in the design would catch it.

`CRYPTO-012 MUST` Each Item revision carries an Ed25519 signature by its author's Account Signing Key,
placed **inside the ciphertext**. Holding a Vault key is otherwise enough to write a revision
attributed to another member, which would make Security History's actor a claim rather than a proof. A
plaintext signature would let an operator attribute every revision to an author, and revision
authorship is not on the `PRIVACY-007` list. The `PRIVACY-004` revision chain hash is
`SHA-256(previous chain hash || envelope bytes)`, computed over ciphertext so a Server can check
continuity without decrypting anything.

`CRYPTO-013 MUST` An Attachment is a sequence of independent envelopes, one per chunk, each binding
the Attachment identifier, its chunk index, and the **total chunk count** in its `CRYPTO-009` tuple.
Binding the count is what makes a truncated Attachment fail to decrypt instead of reading as a short
file. Chunking cannot live above the format, because an AEAD tag verifies only once the whole message
is present and a client would have to buffer an entire Attachment before trusting a byte of it.
`PRIVACY-007` already exposes chunk count, so this binding reveals nothing new.

`CRYPTO-014 MUST` An **Account Fingerprint** is `SHA-256` over a length-prefixed tuple of a domain
label, the Account identifier, the X25519 encryption public key, and the Ed25519 Account Signing
public key, displayed as hex groups. `CRYPTO-005` binds it into every grant signature. It is defined
here rather than later because the signed grant message's field list is frozen by this requirement,
and adding a bound field afterwards would leave two signed forms every verifier must carry. An
operator substituting a recipient's public keys stays Acknowledged until a transparency-log
construction exists; the fingerprint gives out-of-band verification something to compare.

`CRYPTO-015 MUST` A decoder refuses, before returning any plaintext: an unknown format version,
reporting that the client needs updating; key context `0x00` or an unknown context; a context whose
envelope shape does not match the bytes present; a non-zero epoch in a context without epochs; a blob
shorter than its header plus tag, checked before any cryptographic operation runs; trailing bytes
after the tag; and any tag mismatch, with no partial plaintext ever emitted. An epoch naming a Vault
key the client does not hold is reported distinctly from a tag failure, so the client fetches the
grant rather than alarming the User. Ed25519 verification is strict per RFC 8032, rejecting
non-canonical `S` values and small-order points. Nonce reuse is **not** detectable by the format and
the product says so rather than implying a check exists. Every rule here has a negative fixture in the
`AUTH-012` conformance corpus.

## Vaults, Teams, and sharing

`VAULT-001 MUST` A Personal Vault is User-owned. A Team Vault is Team-owned.

`VAULT-002 MAY` Personal Vaults may convert one-way into Team Vaults. Team Vaults do not convert back
to Personal Vaults.

`TEAM-001 MUST` Teams are explicit; solo Users are not represented as Teams of one.

`TEAM-002 MUST` Team roles and Vault roles are separate. Candidate roles are Team Owner/Admin/Member
and Vault Manager/Editor/Viewer.

`TEAM-003 MUST` Team administration does not automatically grant Vault decryption access.

`TEAM-004 MUST` Member departure blocks new writes only in affected Vaults until their key rotation
completes. Unrelated Vaults remain usable.

`SHARE-001 MUST` Ongoing collaboration uses Vault membership. One-off disclosure uses an encrypted
Item snapshot in a Share link. Arbitrary per-Item ACLs are absent.

`SHARE-002 SHOULD` Share links support expiry, maximum views, one-time use, recipient passphrase,
manual revocation, and optional email allowlists when SMTP exists.

## Items and history

`ITEM-001 MUST` Built-in Item categories are Login, Secure Note, Credit Card, Identity, and
Authenticator. Extensibility uses encrypted custom fields rather than user-defined schemas.

`ITEM-002 MUST` TOTP and Passkeys are stored Item capabilities. They are not initial Bittery-login
methods.

`ITEM-003 MUST` Item content, titles, URLs/domains, tags, Favorite, category data, custom fields,
Attachment names, and Attachment MIME types are encrypted. `PRIVACY-006` bounds the exception set.

`ITEM-004 MUST` Concurrent incompatible encrypted edits preserve the later local edit as an explicit
Conflict copy. The Server does not merge ciphertext.

`ITEM-005 SHOULD` Bounded encrypted revision history replaces a separate ad hoc password-history
model. Retention remains configurable.

`ITEM-006 MUST` Trash and permanent deletion synchronize through tombstone behavior that prevents old
offline Devices from resurrecting deleted Items.

`ATTACH-001 MUST` The long-term architecture supports per-Attachment keys wrapped by the Vault key.
Full Attachment UX MAY be deferred from the first release. Selected blobs may be pinned offline.

## Offline, Sync, audit, and Travel mode

`OFFLINE-001 MUST` After initial synchronization, browse, search, autofill, ordinary Item mutations,
personal Vault metadata changes, password/TOTP generation, downloaded Attachment reads, Lock, quick
unlock, and authenticated export work offline.

`OFFLINE-002 MUST` Fresh authorization operations clearly report that they require connectivity.

`OFFLINE-003 SHOULD` Online revalidation defaults to a finite period such as 30 days and is
operator-configurable, including indefinite offline access.

`SYNC-001 MUST` Local durable acceptance precedes network synchronization and immediately updates the
local projection.

`SYNC-002 MUST` Consistency is eventual. Realtime delivery is never required for correctness.

`SYNC-003 MUST` SSE is an optional wake-up optimization. Bounded HTTP push/pull remains authoritative.

`SYNC-004 MUST` Sync represents accepted, queued, rejected, conflicted, indeterminate, and failed
operation states explicitly.

`AUDIT-001 MUST` Audit history splits in two. The Operator Log is readable by administrators and holds
only the `PRIVACY-007` Operator Log fields. The Security History records the actor, Vault, Item, and
object of each security, membership, Vault grant, Share-link, and session event, is encrypted to the
owning User or Team, and is unreadable by an administrator. Both carry configurable retention.

`TRAVEL-001 MUST` Travel mode securely evicts disallowed Vault ciphertext, indexes, and accessible
keys after policy receipt. It makes no impossible promise about Devices that remain offline or storage
forensics/backups.

