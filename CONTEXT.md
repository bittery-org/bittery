# Bittery

A self-hosted, open-source password manager. Users hold Items in Vaults, share Vaults through Teams,
and synchronize through a Server that cannot decrypt Vault content used by a conforming installed
client. The Server does read the fields in the provisional plaintext registry.

This glossary grows lazily. Terms arrive as Wayfinder tickets resolve them, so absence means
undecided, not unimportant.

## Adversaries

**Curious Operator**:
The person running a Server, reading its database, backups, and logs without modifying its code.
_Avoid_: honest-but-curious server, passive admin

**Malicious Operator**:
The person running a Server, modifying its code, forging its responses, and replaying its state.
Bittery treats every operator as potentially this one.
_Avoid_: evil server, hostile admin, compromised host

**Network Attacker**:
An attacker who controls the path between a client and a Server.
_Avoid_: man in the middle, MITM

**Device Thief**:
Someone in physical possession of an enrolled Device while it is locked.
_Avoid_: stolen device attacker, local attacker

**Co-tenant User**:
A User of the same deployment who is not a member of the Vault in question.
_Avoid_: other tenant, neighbour account, same-server user

**Vault Co-member**:
A legitimate member of a Vault, acting outside their remit. Holding the Vault key is enough to write
an Item revision or claim authorship, so signatures rather than encryption are what answer them.
_Avoid_: insider, rogue member, malicious colleague

**Compromised Endpoint**:
An attacker controlling an unlocked client, its runtime, browser, or operating system. A poisoned
build is one route to this compromise.
_Avoid_: Compromised Client Build, malware attacker, poisoned build

## Guarantee tiers

**Prevented**:
An attack that cannot succeed against a conforming build.
_Avoid_: blocked, impossible, mitigated

**Detectable**:
An attack that can be attempted, and that the User's own client catches and reports.
_Avoid_: audited, logged, noticed

**Acknowledged**:
An attack the product does not defend against and states plainly in documentation.
_Avoid_: accepted risk, out of scope, residual risk

## Privacy

**Content secrecy**:
The promise that a Curious or Malicious Operator cannot decrypt Vault content handled by a conforming
installed client using verified recipient keys. It does not hide Server-visible fields or apply to a
Web client's serving operator.
_Avoid_: zero knowledge, end-to-end encryption (when used without its limits)

**Server-visible plaintext**:
The field-level closed registry of data a Server holds unencrypted, enumerated by `PRIVACY-007`. It is
provisional during Wayfinding and becomes release-enforced when the protocol and schema freeze.
_Avoid_: metadata, leakage surface, clear fields

**Operator Log**:
The one audit stream an administrator can read. It contains only registered Server-visible fields and
is operator-controlled administrative evidence, never a security boundary.
_Avoid_: admin log, system log, server audit

## Clients

**Replica**:
The durable engine-owned local state for exactly one Account. Multi-Account and cross-Server flows
coordinate several Replicas and never imply an atomic transaction across them.
_Avoid_: cache, local database, Account cache

**Durability class**:
The closed promise a storage adapter makes when it acknowledges a Replica commit. Bittery has
`native-crash-durable` and `browser-transactional`; the latter applies only while its Origin exists.
_Avoid_: durability level, storage quality, durable (without naming the class)

**Unsynced operation**:
A locally accepted operation for which Sync has not yet proved the matching Server commit. Until
then, its Replica record is the only copy Bittery knows exists.
_Avoid_: pending change, local change, dirty state

**Sync cursor**:
The opaque protocol position through which one Account proves how far its Replica has processed a
particular Sync stream generation. A Device durably pins its greatest accepted position and never
uses a Cursor as an object revision or pagination token.
_Avoid_: event ID, page token, last sync time, revision

**Sync Commit**:
The complete Account-visible effect of one Server transaction at one Sync Cursor position. A client
applies all of its changes together.
_Avoid_: event, change, sync batch, transaction log row

**Bootstrap Lease**:
A temporary Server-held view of one Account at one fixed Sync Cursor from which a Device can resume
building a complete Replica base.
_Avoid_: sync session, snapshot token, pagination cursor

**Tombstone**:
The signed Item revision that places an Item in Trash and points to the last live revision retained
for restoration.
_Avoid_: deleted flag, soft delete, Trash record

**Deletion Fence**:
The signed Tombstone retained after permanent deletion so the same Item identity can never be created,
updated, moved, or restored again within its Vault.
_Avoid_: permanent-delete event, expired tombstone, deleted Item

**Operation**:
One immutable Account-scoped command accepted into a Replica under a random identifier and retried
byte-for-byte until its Server outcome is proved or its local work is explicitly discarded.
_Avoid_: request, queue entry, mutation attempt, pending command

**Operation outcome**:
The immutable canonical result a Server stores for one Operation in the same transaction as its
Domain effect or proved non-effect. It is distinct from the Operation's mutable local lifecycle.
_Avoid_: HTTP response, sync status, retry result, operation state

**Replica Lease**:
The operating-system-released, per-Account file lock shared by ordinary Replica users and held
exclusively for whole-Replica maintenance or removal.
_Avoid_: database lock, process mutex, account lock

**Projection**:
A purpose-built immutable view emitted from a Replica to one client surface. It may contain only the
cleartext that surface needs and remains valid only until its stated invalidation or Account Lock.
_Avoid_: view model, cache, replica

**Search Index**:
The encrypted, derived, Account-local snapshot that supports browse, manual search, and autofill
candidate lookup after Account unlock. It is disposable and never canonical Replica truth.
_Avoid_: search database, autofill cache, Suggestion Index

**Suggestion Index**:
The separately protected local projection a locked Credential Provider uses to match websites or apps
and show the approved preview fields. It contains no credential secret or general Vault content.
_Avoid_: autofill cache, credential replica, search index

**Credential Provider**:
The operating-system-invoked, constrained part of a mobile client that supplies permitted credentials
to other apps. It can authorize its own Provider Unlock Wrapper without a running main client.
_Avoid_: autofill service, mobile extension, main app

**Installed client**:
A released, signed Desktop or Extension build. It is obtained once from a published artifact, so its
integrity does not depend on any Server. Only an installed client holds Accounts from more than one
Server.
_Avoid_: native client, app, desktop app

**Web client**:
The browser client a Server serves at its own origin. It is re-fetched on every load from that
Server, so it holds only that Server's Accounts and its integrity depends on that operator per load.
_Avoid_: web app, browser client, PWA

**Serving operator**:
The operator of the Server that delivered the running Web client. For an installed client there is no
serving operator.
_Avoid_: host, page owner

## Authentication

**Device**:
A separately enrolled local instance of one client surface for one Account. Two surfaces, browser
profiles, or reinstalls on the same hardware are separate Devices.
_Avoid_: physical device, endpoint, client installation

**Device credential**:
The Device-held key pair by which an enrolled Device proves its identity on ordinary Server requests.
It cannot open Account keys and is valid only while its Device Grant remains active.
_Avoid_: device token, session token, client secret

**Device Grant**:
The Account-signed authorization admitting one Device credential and its visible Device identity.
Server issuance alone is not a Device Grant.
_Avoid_: device registration, trusted device record, server credential

**Full sign-in**:
The exchange that proves possession of the master password and the Secret Key to a Server. It runs at
Device enrolment and whenever a Device has no valid Device credential. Ordinary traffic never uses it.
_Avoid_: login, log in, authentication (as a noun for this specific exchange)

**OPAQUE registration**:
The RFC 9807 record by which a Server verifies a full sign-in without learning either remote input.
It belongs to one Account, Server, authentication-protocol version, and key-derivation profile.
_Avoid_: Authentication Key, verifier, password record, login key

**Sign-in attempt**:
The short-lived, single-use Server record carrying one OPAQUE exchange from KE1 through KE3. Its
random identifier correlates HTTP messages but grants no authority by itself.
_Avoid_: Sign-in Challenge, challenge token, login session

**Key-derivation profile**:
The one-byte identifier of a frozen set of Argon2id parameters used as OPAQUE's key-stretching
function. It is not secret. Devices hold it locally and the Emergency Kit prints it because it is part
of the authenticated OPAQUE context before a full sign-in begins.
_Avoid_: Authentication profile, KDF version, work factor, difficulty

**Profile registry**:
The closed, ordered registry of key-derivation profiles compiled into every client. It contains the
immutable identifiers `0x01` through `0xFF`; no entry is removed or reused, and `0x00` is invalid. A
higher identifier is admitted only when review finds it no weaker on every accepted security dimension.
_Avoid_: KDF policy, parameter list, profile table

**Pinned profile**:
The key-derivation profile an Account was created under, which governs its derivation until its owner
accepts an upgrade. Its authoritative identifier is client-carried in Device state, trusted-device
enrollment, or the Emergency Kit; a Server cannot supply or alter it.
_Avoid_: current profile, active profile, account KDF

**Secret Key**:
The 16 machine-generated bytes paired with a master password or Recovery Key for remote unlock. It is
never chosen by a User, never stretched, printed on the Emergency Kit, and reaches a Server only
inside the Account Private Object.
_Avoid_: account key, secret, master key, account secret

**Unlock route**:
One of the closed set of ways into an Account's keys. A remote route combines two separately sourced
secrets intended for separate storage; a local route combines an enrolled Device's held key with its
local authorization. Three exist: master password with Secret Key, Recovery Key with Secret Key, and
an enrolled Device with its local authorization.
_Avoid_: login method, unlock path, access method

**Quick unlock**:
The local Unlock route in which an enrolled Device opens its Account Key Set without a Server or
Secret Key after fresh local authorization. Password quick unlock is the baseline; platform quick
unlock is an optional faster form.
_Avoid_: biometric unlock, local unlock, app unlock

**Password quick unlock**:
Quick unlock authorized by the Account's master password and protected by memory-hard derivation with
Device-held state.
_Avoid_: password-only login, offline login, local password

**Platform quick unlock**:
Quick unlock whose key use or derivation an operating system or authenticator cryptographically gates
on fresh local authorization.
_Avoid_: biometric unlock, Face ID unlock, platform login

**Device Unlock Wrapper**:
The Device-bound protection around one Account Key Set that releases it only into an unlocked core
session after fresh local authorization. It never exposes Account keys through a client binding.
_Avoid_: biometric wrapper, session wrapper, local key store

**Provider Unlock Wrapper**:
The Credential Provider's separately authorized protection around one Account Key Set. It releases
the keys only into the Provider's constrained core session and never through a platform binding.
_Avoid_: provider key, autofill key, shared wrapper

**Device factor**:
The random local value paired with the master password for one password quick-unlock wrapper. It
supplies the Device-held input but is not claimed to stay secret when Device storage is copied.
_Avoid_: device secret, local salt, quick-unlock token

**Platform anchor**:
The local operating-system or authenticator credential through which a Device profile may authorize
platform quick unlock for several independently wrapped Accounts. Secure Enclave uses one per
installation; WebAuthn uses one per Server RP.
_Avoid_: biometric key, primary Account, shared Account key

**Unlocked Account**:
An Account whose Account Key Set is present in the core's current in-memory session.
_Avoid_: authenticated Account, open Account, active Account

**Lock**:
The act of removing live Account and wrapping keys while preserving encrypted local state, Device
enrollment, and configured Unlock routes.
_Avoid_: sign out, remove Account, close vault

**Account removal**:
The local lifecycle action that makes one Account permanently unopenable on a Device and then resumes
deletion of its Replica, credentials, and wrappers until complete. It does not imply Server revocation.
_Avoid_: sign out, log out, Lock

**Auto-lock**:
A Lock across every Account in one runtime host caused by inactivity or a security-relevant platform
event. Explicit Device Lock and shared platform events may invalidate several hosts.
_Avoid_: session expiry, sign out timer, idle logout

**Recovery Key**:
The optional machine-generated secret that, together with the Secret Key, opens the Account Key Set
when the master password is gone. It opens nothing on its own.
_Avoid_: recovery code, reset code, backup key, recovery password

**Emergency Kit**:
The document a client produces at Account creation, holding the Server address, the Account email
address, the Secret Key, the authentication-protocol version, the key-derivation profile identifier,
and the Account Fingerprint. It is emitted separately from the Recovery sheet and never carries a
Recovery Key or a master password.
_Avoid_: Recovery Kit, backup file, account kit

**Recovery sheet**:
The document holding a Recovery Key. A client emits it separately from the Emergency Kit and tells the
User to store it elsewhere, so no product-created artifact carries both remote-recovery secrets.
_Avoid_: recovery card, second kit, recovery page

**Recovery sign-in**:
The remote ceremony proving possession of the Recovery Key and Secret Key independently of full
sign-in. It ends only after a new master password, Secret Key, Recovery Key, and the revocation of
every other Device and session are committed as one replacement after the new documents are saved.
_Avoid_: account recovery, password reset, recovery login

**Recovery attempt**:
The short-lived Server record that moves from an unproven recovery challenge to a proven replacement
ceremony and then to one committed result. Its identifier grants no authority without the matching
recovery signatures.
_Avoid_: recovery session, reset token, recovery token

**Recovery Key removal**:
The deletion of the live Recovery Key route from current Server state. It provides forward protection
and does not erase old wrappers or secrets another party already copied.
_Avoid_: Recovery Key revocation, invalidation, erasure

## Abuse defense

**Sign-in cooldown**:
The minimum wait before one Account subject may make its next full-sign-in or recovery-sign-in attempt
after repeated failures. It permits sparse retries and is not an Account state an operator can unlock.
_Avoid_: Account lock, lockout, ban

**Fake OPAQUE exchange**:
The RFC 9807 exchange a Server runs for an unknown Account using its ordinary OPAQUE setup, so the
public response does not disclose whether an Account exists.
_Avoid_: fake verifier, dummy Account, synthetic login

## Cryptographic format

**Envelope**:
The single container every persisted ciphertext is written in. It carries a format version, a key
context, a key epoch, and either a nonce or an HPKE encapsulated key, followed by ciphertext and its
tag. There is one envelope in the product, in two shapes chosen by key context.
_Avoid_: blob, ciphertext record, payload, sealed box

**Format version**:
The single byte naming an envelope's entire cryptographic suite: AEAD, KEM, KDF, signature algorithm,
hash, and byte layout together. It indexes a closed, ordered, append-only registry compiled into every
client, so no algorithm is ever negotiated. Distinct from the key-derivation profile, which governs
the memory-hard step only.
_Avoid_: suite id, cipher version, algorithm identifier, crypto version

**Key context**:
The byte identifying which key an envelope was encrypted under and what kind of object it holds. It
selects the envelope shape and the fields of the binding tuple. Its table is closed.
_Avoid_: envelope type, purpose byte, record kind

**Binding tuple**:
The identity of the object an envelope belongs to, which a decoder reconstructs from where it found
the envelope and authenticates as additional data. Moving ciphertext elsewhere therefore fails to
decrypt. A Share link snapshot binds the link, never the Item it came from.
_Avoid_: context header, associated data, metadata

**Account Unlock Key**:
The 32-byte symmetric key that labeled HKDF-Expand derives from OPAQUE's client-only export key. It
wraps the Account Key Set and nothing else.
_Avoid_: master key, master unlock key, vault-unlock material, MUK

**Account Key Set**:
The randomly generated X25519 encryption key pair and Ed25519 Account Signing Key pair belonging to an
Account, stored as one envelope wrapped by the Account Unlock Key. Every ceremony that changes a
credential re-wraps this one object and leaves every Vault key untouched.
_Avoid_: account keypair, identity key, user keys

**Account Signing Key**:
The Ed25519 key pair inside the Account Key Set, which signs Vault grants and Item revisions. Distinct
from OPAQUE's ephemeral authentication keys and Server-held registration record.
_Avoid_: identity key, signing identity, author key

**Vault key**:
The symmetric key of one Vault generation, sealed individually to each member's Account encryption
key. It encrypts Item revisions directly and wraps Attachment keys. No Team-level key sits above it.
_Avoid_: vault secret, shared key, collection key

**Key epoch**:
The positive, consecutive generation of a Vault key, carried in every envelope encrypted under it.
The first epoch is 1 and each rotation advances it by exactly one.
_Avoid_: key version, rotation number, generation

**Vault key rotation**:
The forward boundary that replaces a Vault key for newly accepted writes. It does not rewrite old
Item or Attachment envelopes or revoke knowledge of an earlier key.
_Avoid_: re-encryption, key refresh, retroactive revocation

**Rotation requirement**:
The non-expiring state that makes one Vault read-only after access loss or envelope-budget exhaustion
until a conforming client commits the next key epoch.
_Avoid_: rotation plan, maintenance mode, rotation job

**Vault epoch statement**:
The Account-signed record binding one Vault rotation to its predecessor, trigger, membership revision,
and complete ordered grant set.
_Avoid_: rotation record, key manifest, epoch certificate

**Envelope budget**:
The fixed number of Vault-key encryptions reserved before a Device may create offline envelopes. It is
a cryptographic usage bound, not an operator quota.
_Avoid_: encryption quota, nonce budget, storage allowance

**Vault grant**:
A Vault key sealed to one member's Account encryption key, together with the signature of the member
who granted it. A client accepts no grant whose signature does not verify; a Server authorization
record grants nothing.
_Avoid_: share, permission, access record, membership

**Account Private Object**:
The small signed container sealed to an Account's own encryption key, holding the current Secret Key.
It is how an enrolled Device learns that the Secret Key rotated without being re-enrolled.
_Avoid_: account blob, private settings, key store

**Attachment manifest**:
The ordered list inside a signed Item revision that commits to each Attachment's wrapped key, size,
chunk count, and chunk-envelope digests.
_Avoid_: attachment index, file list, upload manifest

**Account Fingerprint**:
A hash over an Account's identifier and both public keys, bound into every grant signature and
displayable for out-of-band comparison. It gives two people something to check when neither can trust
the Server that published the keys.
_Avoid_: safety number, key hash, verification code
