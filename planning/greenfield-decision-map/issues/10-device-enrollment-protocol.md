# Device enrollment protocol

Type: grilling
Status: resolved
Blocked by: 08, 09, 54

## Question

`AUTH-004` names three enrollment paths (trusted-device QR, master password plus Secret Key, Emergency Kit) and says the Server alone cannot provision decryption keys. The protocol behind the QR path does not exist yet.

Decide:

- The trusted-device enrollment protocol end to end: channel, authentication of both ends, what the QR payload carries, replay and relay resistance, and expiry.
- Whether the existing device must approve explicitly, and what it displays so a user can detect a relay attack.
- What the Server sees during enrollment, checked against the closed plaintext list.
- Device identity: how a Device is named, keyed, and listed, and whether it holds a device keypair.
- Enrollment when the user has exactly one device and it is lost.
- Rate limiting and abuse on the enrollment endpoints.

Produces: an enrollment protocol specification, `AUTH-004` refinement, and seed scenarios.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

**Superseded by ticket 04's reopened answer:** silent enrollment is not Detectable when a Malicious
Operator equivocates between Devices. This ticket must make a Server-issued Device credential
insufficient to obtain Account keys and must state which enrollment facts a client can detect from
state it actually receives.

`PRIVACY-004` makes silent Device enrollment Detectable, not merely audited. Every existing Device of
an Account must be told when a Device is enrolled, and the notification cannot depend on the Server
choosing to deliver it. `PRIVACY-007` puts the Device name in Server-visible plaintext, so enrollment
carries a user-chosen label the operator reads.
### Inherited from ticket 06, password authentication protocol

`AUTH-011` makes OPAQUE full sign-in authenticate **Device enrolment only**. It derives a one-use
confirmation key from the OPAQUE session key with `bittery/opaque/device-credential/1`; HMAC-SHA-512
under that key must cover this ticket's canonical issuance payload. Credential issuance and successful
KE3 processing commit atomically, after which the session and confirmation keys are erased.

Device state holds both one-byte version identifiers. An enrolled Device is also an independent route
that may authorize atomic OPAQUE record-and-wrapper replacement when the old protocol is unsafe to run.
This ticket must define that authorization without turning the Device credential into a general root-
credential replacement endpoint.

### Inherited from ticket 07, key derivation profiles

`AUTH-019` fixes how a Device with no local state learns the Account's **pinned key-derivation
profile**: the Emergency Kit prints it and trusted-device enrollment transports it. There is no Server
endpoint, Server-selected pin, fallback, or registry walk. A missing, stale, or unsupported pin refuses
full sign-in with recovery guidance, and the profile remains a separate field beside the stable `SK1`
Secret Key code.

Device state holds the pinned profile identifier. `AUTH-018` requires an upgrade offer at the end of a
full sign-in when the Server advertises a compiled, deployment-supported, stronger profile, so enrolment
is one of the moments that offer can appear. The User may defer.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-001` settles what enrolment actually transports: the **Account Key Set**, not a set of Vault
keys. Vault keys seal to the Account encryption key, never to a Device key, so a new Device that holds
the Account Key Set can open every Vault the Account was granted without the Server re-wrapping
anything. `CRYPTO-010` reserves key context `0x03` for the Account Key Set under a Device Unlock
Wrapper key, which is where the enrolled Device parks it.

A Device key pair still exists, but only for the `AUTH-011` Device credential on ordinary traffic. It
never receives Vault content. `CRYPTO-014`'s Account Fingerprint is the natural thing for a QR
enrolment to display and confirm.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-004` now names the three enrolment inputs as trusted-device QR, master password plus Secret Key,
and the `AUTH-026` recovery sign-in. A fresh Device reads the Server address, the Account email, the
Secret Key, the profile identifier and the Account Fingerprint from the Emergency Kit, and `AUTH-024`
gives it a check symbol to validate before any derivation runs.

Enrolment must deliver the `AUTH-027` Account Private Object alongside the Account Key Set, or a
Device enrolled before a Secret Key rotation will never learn the current Secret Key.

`AUTH-026` ends recovery by enrolling the recovering Device and revoking every old Device credential
and session in the same transaction that publishes the replacement Account Private Object. Its signed
`RecoveryReplacement` contains this ticket's canonical Device-credential issuance request as one
length-prefixed field. This ticket must fix those bytes so OPAQUE enrolment and recovery enrolment use
one request shape.

Outside recovery, `AUTH-027` preserves trusted Devices by default and applies only the revocations the
User selected. Those revocations and the new Account Private Object still commit atomically. What an
already-running or offline Device observes remains this ticket's decision inside `AUTH-008`'s limit.

### Inherited from the 2026-08-20 consistency audit

Ticket 09 resolved the Server transition: an honest Server makes old Device and session revocation,
replacement-object publication, and recovering-Device credential issuance one atomic commit. It never
serves the new object through a credential revoked by that commit. A Malicious Operator can still send
the ciphertext to an old Device that already holds the Account Key Set; the threat model acknowledges
that limit. This ticket owns Sync visibility and the behavior of an already-running or offline Device.

### Session resumed 2026-08-21

The trusted-Device path uses the Server as a rendezvous and relay. The QR binds a short-lived
enrollment attempt to the new Device and its ephemeral key. The trusted Device sends the Account Key
Set and required private Account state only through an end-to-end encrypted transfer; the Server
never receives that plaintext. A direct local connection and a full transfer encoded in QR were
rejected because they add platform-specific connectivity or a large, brittle visual payload.

The trusted Device transfers nothing on scan alone. It creates an HPKE sender context and relays only
the public encapsulated key and Account Fingerprint. Both Devices derive and display the same short
comparison code from the secret HPKE exporter, bound to the signed QR attempt and offer, alongside the
proposed Device name. The User compares the displays and explicitly approves on the trusted Device. This makes a QR
relayed from a remote Device visible without requiring both Devices to have cameras.

Enrollment authority is a durable **Device Grant** signed by the Account signing key. It binds the
new Device identifier, public credential key, user-chosen Server-visible name, and enrollment order.
A Server-issued credential or possession of relay ciphertext is insufficient without that grant.
The Server and every Device can verify the Account's authorization independently.

The Device-credential model was held open pending
[Device credential patterns in established password managers](54-device-credential-patterns.md),
then resolved from that evidence below.

After that research, Bittery rejects both replayable Bearer refresh credentials and a copied session
key as the ordinary authority. Each Server request carries a replay-protected Ed25519 proof made by
the private Device credential key named in the Account-signed Device Grant. A short Server session
identifier scopes the proof but grants nothing by itself.

The honest Server checks the Device Grant and authoritative Device status on every request. Revocation
therefore rejects the Device's next request even in an already-open session. It cannot erase Account
keys, ciphertext, or plaintext the Device obtained before revocation, and an offline Device learns of
revocation only when it reconnects.

Each Device session has its own monotonically increasing `u64` request counter. The Server keeps the
highest accepted value and a fixed replay bitmap behind it, so bounded reordering and concurrency are
valid while a counter value is accepted at most once. A random request identifier set and a fresh
Server round trip for every request were rejected.

The relay transfer reuses format `0x01`'s complete RFC 9180 HPKE Base suite and the new Device's
ephemeral X25519 recipient key. The Account-signed Device Grant authenticates the transferred content,
and the Device credential proofs bind the recipient. The comparison code is a transcript-derived
human check, not a low-entropy PAKE input. Noise and CPace were rejected as second constructions for
a job the high-entropy QR key and existing suite already satisfy.

An enrollment attempt contains the protocol version, stable Server identity, random 128-bit attempt
identifier, expiry, proposed Device identifier and Server-visible name, the Device's Ed25519 credential
public key, its ephemeral X25519 relay key, and proof of the credential private key. It expires after five
minutes. The credential key is proved in the attempt; the HPKE private key is proved by the later
encrypted receipt. The attempt is consumed by the first valid approval. Only byte-identical retrieval of the already
fixed result is idempotent until expiry; altered replay is rejected.

A **Device** is one separately enrolled local client-surface installation for one Account and owns one
credential key. Desktop, Extension, a Web browser profile, and a reinstall on the same hardware are
separate Devices with separate list entries and revocation. A physical-device identity or grouping
layer was rejected because it needs cross-surface key sharing or a second identity model.

Device state is a sequence of Account-signed Add, Rename, and Revoke events with a monotonically
increasing generation. Each Device remembers the greatest generation it accepted and rejects rollback;
ordinary Sync carries later events and surfaces them to the User. The Server can withhold or fork valid
history between Devices, which remains Acknowledged until a transparency mechanism exists, but it
cannot create a valid event. A Server-only mutable list and a full signed snapshot per change were
rejected.

Immediately before it signs the Add event and creates the HPKE transfer, the trusted Device requires
fresh local authorization of the same kind that opens its Device Unlock Wrapper. Merely being unlocked
is insufficient; the trusted path does not ask for the master password or Secret Key again.

Trusted enrollment has a pending and an active phase. Approval fixes a short-lived encrypted transfer
and pending signed Add event. Only the new Device's first valid credential-key proof after successful
decryption atomically activates the Device Grant and Add event and consumes the attempt. An uncollected
pending Device expires without entering the Device list.

Enrollment owns abuse scopes separate from sign-in and recovery. Public attempt starts allow twenty
per source address in fifteen minutes and at most five live attempts per source. Approval and
activation share limits of five submissions per Account and ten per source per hour. All stages also
reserve deployment-sized Server capacity through the authoritative abuse-state adapter; an endpoint
cannot spend another ceremony's budget.

A Device session expires after thirty minutes without an accepted request and after twenty-four hours
absolutely. Activity extends only the idle deadline. An active Device silently opens a new session by
answering a fresh Server challenge with its credential key; there is no refresh credential. These
deadlines primarily bound replay state, because every request still proves the Device key and checks
current revocation status.

Ordinary requests use one fixed RFC 9421 HTTP Message Signatures profile with Ed25519. The covered
components always include method, target, `Content-Digest`, structured Session identifier, and the
structured `u64` replay counter; the application accepts no negotiated or alternate coverage set.
This replaces a bespoke binary HTTP-proof format while keeping one exact form across all surfaces.

An enrolled Device may authorize replacement of an unsafe OPAQUE version only through a dedicated
atomic command. It requires fresh local authorization, an active Device request proof, and an Account
signature binding the old version, new version and profile, new registration and `0x01` wrapper, and
the expected generation. The command can change no recovery, Account-key, Device, or other root state;
a Device credential alone is insufficient.

A Device credential key never rotates in place. A replacement key is a newly enrolled Device with a
new identifier, grant, and Add event; the old Device is revoked separately. This keeps reinstallations
and compromise boundaries explicit and avoids claiming that rotation makes a copied Account Key Set
forget anything.

Before scan, the public pending attempt is not associated with an Account or email address. The Server
sees only protocol and expiry fields, Device identifier and name, surface type, both public keys and
the credential-key possession proof, source address, and operational timestamps. Approval adds the Account,
signed event, relay-ciphertext length, and ordinary operational state. The Account Key Set, Account
Private Object, pinned profile and protocol versions, Account Fingerprint, and current Secret Key
remain inside HPKE ciphertext.

The human comparison value is exactly six decimal digits displayed as two groups of three. Leading
zeroes are significant. It is derived from the secret HPKE exporter and bound to the signed QR attempt
and public offer, shown on both Devices, and compared but never entered. It is a relay-warning display,
not credential material.

Every signed Device-status event also requires live route authority in the same atomic commit. A
trusted-Device command carries a current Device request proof, full sign-in carries the OPAQUE commit,
and recovery carries the `RK1` commit. An Account signature copied from, or newly made by, a revoked
Device is insufficient at an honest Server.

Device-status events form one Account-wide compare-and-swap sequence. Each signature binds the
previous and next `u64` generation, and the honest Server commits only exactly `current + 1`. A
concurrent conflict requires the updated state and changed bytes to be reviewed and signed again; the
Server never inserts a sequence after signature.

When Sync first delivers an Add event to an existing Device, it creates a persistent security notice
showing the new name, surface, and time. The Account-access area remains marked unseen until the User
opens it. Push delivery is advisory; ordinary Sync is authoritative. A Malicious Operator that
withholds or forks the event remains outside this guarantee.

Device-session challenge starts reveal no Device existence and are limited to sixty per source in
fifteen minutes, at most twenty live per source, plus Server capacity. Only a valid proof consumes the
separate limit of thirty successful opens per Device per hour. Unknown identifiers receive the same
challenge shape and outward proof failure; merely knowing a Device identifier cannot exhaust a
Device-scoped budget.

The new client generates the stable Device identifier as sixteen uniformly random bytes before any
enrollment route. The identifier is independent of Server database identity, label, and public-key
encoding and is bound by every grant, event, issuance request, session, and request proof. The Server
never substitutes it after signature.

The trusted transfer includes a one-time Account-signed Device-roster checkpoint containing the full
current status, the pending new Device, and the resulting generation. That checkpoint gives the new
Device its independent baseline; ordinary Sync supplies only later signed events. Enrollment does not
carry or require indefinite Device-event history.

The Device name is an editable Server-visible label, never identity. A client suggests a surface and
platform description before approval; duplicate names are valid, while identifier and surface type
remain explicit in the list. A later rename is another Account-signed status event.

## Answer

Promoted to rewritten [`AUTH-004`](../../../docs/greenfield/target/product.md), `AUTH-008`,
`AUTH-011`, `AUTH-014`, new `AUTH-031` through `AUTH-040`, `ABUSE-015` and `ABUSE-016`, the Device
protocol section of the [`cryptographic format`](../../../docs/greenfield/target/cryptographic-format.md),
three terms in [`CONTEXT.md`](../../../CONTEXT.md), and accepted ADR
[0019](../../../docs/adr/0019-device-admission-is-account-signed-and-every-request-proves-the-device-key.md).

**All enrollment routes produce one authority.** Trusted-device QR, OPAQUE full sign-in, and `RK1`
recovery each commit the same canonical Device-credential request. Its durable Device Grant is an Add
event signed by the Account key, and the new Device separately proves the private credential key.
A Server record alone admits nothing and opens no Account keys.

**A Device is one local Account installation.** Web profiles, Desktop, Extension, and reinstalls are
separate Devices. Each creates a random 16-byte identifier and an Ed25519 credential key. The name is
an editable, duplicate-friendly Server-visible label. A new key is a new Device rather than an
in-place rotation.

**Trusted transfer is a short Server-relayed HPKE ceremony.** The Account-unassociated QR attempt
lives five minutes and binds the Server, proposed Device, credential key, and ephemeral X25519 key.
The trusted Device first relays only a public HPKE offer; both displays derive a six-digit comparison
value from the secret exporter. It transfers no Account secret until the User compares, grants fresh
local authorization, and approves. The complete RFC
9180 suite carries the Account Key Set, Account Private Object, version pins, Account Fingerprint,
Device Grant, receipt nonce, and signed roster checkpoint as ciphertext. Only a post-decryption
credential-key receipt atomically activates the pending Device.

**Device state is Account-signed and monotonic.** Add, Rename, and Revoke events use one `u64`
compare-and-swap generation and require both the Account signature and live route authority. Each
Device rejects state below the highest generation it accepted. Existing Devices show a persistent
notice when Sync first delivers an Add. A Malicious Operator can still withhold or fork valid state
between Devices; the product acknowledges that rather than claiming a transparency property.

**Ordinary traffic proves the Device key.** A five-minute signed challenge opens a 30-minute-idle,
24-hour-absolute Session with no refresh credential. Every request uses the fixed RFC 9421 Ed25519
profile and a per-Session `u64` counter with a 64-entry replay window. The honest Server checks current
Device status on every request, so revocation rejects the next request even in an open Session. It
cannot erase material already held locally.

**Unsafe OPAQUE migration remains narrow.** A dedicated atomic replacement needs fresh local
authorization, a valid Device request proof, and an Account signature over the exact new registration,
wrapper, versions, profile, and generation. It cannot mutate recovery, Account keys, Device state, or
other roots.

**Abuse state is isolated by ceremony.** Enrollment starts, approvals and activations, and Device
Session challenges each have their own source, Account or proven-Device, concurrency, and Server
capacity bounds. Unknown Device identifiers have the same challenge shape and do not consume a
Device-scoped budget before a valid proof.

If the only Device is lost, full sign-in or recovery enrolls its replacement. There is no special
operator path. No additional fog graduated and no new decision ticket surfaced beyond the resolved
research ticket [Device credential patterns in established password managers](54-device-credential-patterns.md).
