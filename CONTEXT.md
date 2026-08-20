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

**Full sign-in**:
The exchange that proves possession of the master password and the Secret Key to a Server. It runs at
Device enrolment and whenever a Device has no valid Device credential. Ordinary traffic never uses it.
_Avoid_: login, log in, authentication (as a noun for this specific exchange)

**OPAQUE registration**:
The RFC 9807 record by which a Server verifies a full sign-in without learning either password factor.
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
The closed, ordered, append-only table of key-derivation profiles compiled into every client. A Server
names one entry and supplies no parameters. An entry is never removed, because it is the only route to
the Vault keys of every Account pinned to it.
_Avoid_: KDF policy, parameter list, profile table

**Pinned profile**:
The key-derivation profile an Account was created under, which governs its derivation until its owner
accepts an upgrade. A client derives under it whatever a Server publishes.
_Avoid_: current profile, active profile, account KDF

**Secret Key**:
The 16 machine-generated bytes that are the second factor of a full sign-in. It is never chosen by a
User, never stretched, printed on the Emergency Kit, and reaches a Server only inside the Account
Private Object.
_Avoid_: account key, secret, master key, account secret

**Unlock route**:
One of the closed set of ways into an Account's keys, each consuming two independent factors. Three
exist: master password with Secret Key, Recovery Key with Secret Key, and an enrolled Device with its
local authorization.
_Avoid_: login method, unlock path, access method

**Recovery Key**:
The optional machine-generated secret that, together with the Secret Key, opens the Account Key Set
when the master password is gone. It opens nothing on its own.
_Avoid_: recovery code, reset code, backup key, recovery password

**Emergency Kit**:
The document a client produces at Account creation, holding the Server address, the Account email
address, the Secret Key, the authentication-protocol version, the key-derivation profile identifier,
and the Account Fingerprint. It never carries a Recovery Key or a master password.
_Avoid_: Recovery Kit, backup file, account kit

**Recovery sheet**:
The separate document holding a Recovery Key. It exists apart from the Emergency Kit so that no single
page carries two factors.
_Avoid_: recovery card, second kit, recovery page

**Recovery sign-in**:
The full sign-in variant proving possession of the Recovery Key and the Secret Key. It ends only after
a new master password, a Secret Key rotation, a new Recovery Key, and the sign-out of every other
Device.
_Avoid_: account recovery, password reset, recovery login

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
The generation of a Vault key, carried in every envelope encrypted under it. A rotation starts a new
epoch for new writes; older ciphertext stays readable under its own epoch until it is rewritten, or
forever.
_Avoid_: key version, rotation number, generation

**Vault grant**:
A Vault key sealed to one member's Account encryption key, together with the signature of the member
who granted it. A client accepts no grant whose signature does not verify; a Server authorization
record grants nothing.
_Avoid_: share, permission, access record, membership

**Account Private Object**:
The small container sealed to an Account's own encryption key, holding the current Secret Key. It is
how an enrolled Device learns that the Secret Key rotated without being re-enrolled.
_Avoid_: account blob, private settings, key store

**Account Fingerprint**:
A hash over an Account's identifier and both public keys, bound into every grant signature and
displayable for out-of-band comparison. It gives two people something to check when neither can trust
the Server that published the keys.
_Avoid_: safety number, key hash, verification code
