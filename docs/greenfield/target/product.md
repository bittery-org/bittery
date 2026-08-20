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

`PRIVACY-001 MUST` The product names six adversary classes: Curious Operator, Malicious Operator,
Network Attacker, Device Thief, Co-tenant User, and Compromised Client Build. Every security
requirement states which class it answers.

`PRIVACY-002 MUST` Each attack available to a Malicious Operator is classed Prevented, Detectable, or
Acknowledged. A Prevented attack cannot succeed. A Detectable attack is reported to the User by their
own client. An Acknowledged attack is stated in product documentation and not defended against.

`PRIVACY-003 MUST` A Malicious Operator cannot read Item content, and cannot forge a Vault grant that
a client accepts. A member holding the Vault key grants access by wrapping that key. A Server
authorization record never grants access. Server-side access control is an availability and abuse
control only.

`PRIVACY-004 MUST` Five Malicious Operator attacks are Detectable. Enrolling a Device without every
existing Device of that Account being told. Presenting Vault membership that no member signed.
Replaying Server state older than a client already accepted. Dropping or reordering an Item revision,
which a per-Item revision chain exposes. Serving every User a Web client bundle that is not the
published release, which `PRIVACY-016` makes checkable by any third party.

`PRIVACY-005 MUST` Five attacks are Acknowledged. Denial of service. Withholding data from a client.
Server equivocation between two Devices of one Account. Every field on the `PRIVACY-007` list.
Serving a substituted Web client bundle to a single targeted User, which `PRIVACY-015` states plainly.

`PRIVACY-006 MUST` `PRIVACY-007` is a closed list. Any field the Server holds in plaintext that
`PRIVACY-007` does not name is a defect. A repository check fails on any plaintext Server schema
column absent from the list.

`PRIVACY-007 MUST` Server-visible plaintext is exactly:

- **Account** — identifier, email address, status, password-authentication record, public keys.
- **Device** — identifier, user-chosen name, public key, enrollment sequence number.
- **Vault and Team** — identifier, name, owning User or Team, membership with role, wrapped Vault
  keys, current key epoch.
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
password-derived value. No password-derived secret ever reaches the Server, at rest or on the wire. The
Vault-unlock derivation is a second, independent memory-hard run, satisfying `AUTH-002`. ADR 0006
records why OPAQUE, SRP-6a, and an authentication hash were rejected.

`AUTH-009 MUST` The signed message is canonical and length-prefixed, and binds a purpose label, the
protocol version, the Server identity, the Account identifier, and a single-use Sign-in Challenge issued
by the Server. Binding the Server identity is what stops a hostile Server relaying a challenge from
another Server, which `ACCOUNT-001` makes a live case for installed clients.

`AUTH-010 MUST` The authentication salt derives from the Secret Key on the client. The Server stores no
salt, sends no salt, and exposes no endpoint that reveals whether an Account exists before a full sign-in
begins. Key-derivation parameters are Server-wide and published in the Server descriptor, not per
Account, so no Device can be handed weaker parameters than another. The Authentication profile
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

