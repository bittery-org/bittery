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

`PRIVACY-004 MUST` Four Malicious Operator attacks are Detectable. Enrolling a Device without every
existing Device of that Account being told. Presenting Vault membership that no member signed.
Replaying Server state older than a client already accepted. Dropping or reordering an Item revision,
which a per-Item revision chain exposes.

`PRIVACY-005 MUST` Four attacks are Acknowledged. Denial of service. Withholding data from a client.
Server equivocation between two Devices of one Account. Every field on the `PRIVACY-007` list.

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
detects its own compromise.

`PRIVACY-013 MUST` Product documentation states the `PRIVACY-007` list in plain language, naming Vault
names, Team names, Device names, email addresses, and the Vault membership graph as readable by the
operator.

`PRIVACY-014 MUST` Server request logs carry a documented default retention bound. Unbounded request
logging reintroduces the wall-clock history that `PRIVACY-008` removes.

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

## Administration and registration

`ADMIN-001 MUST` Administrators control admission, suspension, quotas, retention, and deletion of
encrypted server data. They cannot decrypt or impersonate Users, and cannot reset cryptographic
secrets. Enrolling a replacement Device is Detectable, not Prevented. `PRIVACY-002` defines these
words, and `PRIVACY-007` bounds what an administrator sees.

`ADMIN-002 MUST` Registration supports configurable open, invitation-only, and closed modes.
Administrator-created enrollment is an invitation; administrators never choose user secrets.

## Accounts, Servers, and unified use

`ACCOUNT-001 MUST` One client can configure Accounts from several independent Servers.

`ACCOUNT-002 MUST` Local Account identity is scoped by stable Server identity and User identity, not
email or URL alone.

`ACCOUNT-003 MUST` The active scope may be one Account, one local Collection, or All Accounts.

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

`AUTH-003 SHOULD` RFC 9807 OPAQUE is the intended password-authentication protocol. Exact suite and
record encoding remain OPEN until conformance and security-review gates pass.

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

