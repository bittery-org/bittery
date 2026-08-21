# Candidate greenfield product target

Status: **Candidate**.

## Product position

`PROD-FOUNDATION-001 MUST` Bittery is fully open source and self-hosted. Bittery operates no hosted
cloud product.

`PROD-FOUNDATION-002 MUST` Normal enrollment and synchronization require a Server. Once initialized,
ordinary Vault use remains offline-first.

`PROD-FOUNDATION-003 MUST` A deployment supports multiple Users and Teams. With a conforming
installed client, an operator cannot decrypt Vault content. This is a content-secrecy promise, not a
"zero knowledge" claim; `PRIVACY-007` names the Server-visible data and `PRIVACY-015` states the Web
client's weaker guarantee.

`PROD-FOUNDATION-004 MUST` Billing, plans, subscriptions, Stripe, commercial entitlements, and
hosted-cloud operational branches are absent from the product.

`PROD-FOUNDATION-005 MUST` The rebuild is a clean product reset. It need not open current Accounts,
ciphertext, Attachments, databases, or protocols.

## Threat model and privacy

`PRIVACY-001 MUST` The product names seven adversary classes: Curious Operator, Malicious Operator,
Network Attacker, locked Device Thief, Co-tenant User, Vault Co-member, and Compromised Endpoint.
Every security requirement states which class it answers. A poisoned build is one route to a
Compromised Endpoint; reproducible-build checks verify releases but do not protect a running endpoint.

`PRIVACY-002 MUST` Each named attack is classed Prevented, Detectable, or Acknowledged. Prevented means
the attack cannot succeed against a conforming client. Detectable means that same client catches and
reports the attack. Acknowledged means Bittery neither prevents nor reliably detects it and documents
the limitation. External auditability or a published hash alone never makes an attack Detectable.

`PRIVACY-003 MUST` With a conforming installed client, a Curious or Malicious Operator cannot decrypt
Vault content. A member grants access by sealing the Vault key to a recipient key that was verified out
of band and signing the grant. Account-level signatures authenticate grants, role changes, and Item
revisions. Server authorization records limit availability and abuse but grant no cryptographic access.

`PRIVACY-004 MUST` A client detects and reports authenticated state older than the highest revision it
has already accepted, a changed public key after out-of-band verification, and a grant, role change, or
Item revision whose Account signature is invalid or unauthorized by the signed role state. The client
does not claim to detect a revision no client ever observed. There is no mandatory per-Item revision
chain or first-release transparency log.

`PRIVACY-005 MUST` The following are Acknowledged: denial of service; withholding data no client has
already observed; Server equivocation between clients; every field and chronology on `PRIVACY-007`;
targeted or fleet-wide Web-client substitution by its serving operator; malware, a compromised OS or
browser, runtime injection, or control of an unlocked client; and reopening long-lived Account keys
from a backed-up wrapping plus the matching old secrets. Product documentation must not imply that
published hashes, audit logs, revocation, or remote sign-out prevent these attacks.

`PRIVACY-006 MUST` `PRIVACY-007` is a field-level closed registry. While Wayfinding remains open the
registry is explicitly provisional, and every decision adding Server-visible state amends it. The
public protocol and Server schema gate freezes it. From that gate onward, a release-blocking repository
check fails on any plaintext Server schema field absent from the registry.

`PRIVACY-007 MUST` The provisional Server-visible plaintext registry is:

- **Server and protocol** — Server identity, supported protocol versions, published configuration,
  key-derivation policy, migration state, and instance status.
- **Account** — identifier, email address, status, authentication records, public keys, wrapped Account
  keys, recovery-record existence and wrappers, encrypted Account-private objects, and operational
  timestamps.
- **Authentication and abuse control** — Sign-in attempt identifier, OPAQUE state, versions,
  consumption and expiry;
  Device credential or session identifier, authentication material, scope, expiry and revocation;
  source address; and rate-limit keys, counters and windows.
- **Device** — identifier, user-chosen name, public key, enrollment order, status, and operational
  timestamps.
- **Invitation** — identifier, email address, inviter, target Team or Vault, role, status, expiry, and
  operational timestamps.
- **Vault and Team** — identifier, name, owning User or Team, complete membership and roles, signed
  role state, wrapped Vault keys with granter and recipient identifiers and grant signatures, current
  key epoch, and operational timestamps.
- **Item** — identifier, owning Vault, ciphertext, ciphertext length, revision number, tombstone
  marker, retention time, and operational timestamps.
- **Attachment** — identifier, owning Item, chunk count, total byte size, wrapped Attachment key,
  upload state, retention time, and operational timestamps.
- **Share link** — identifier, expiry, view count, maximum views, ciphertext, ciphertext length, and
  operational timestamps.
- **Sync and command processing** — per-Vault sequence records carrying Item identifier and operation
  kind, cursor and retention state, idempotency key and outcome, and operational timestamps.
- **Operator Log** — actor Account or administrator identifier, event category, affected Server-visible
  identifiers, sequence number, source address, byte counts, and timestamp.
- **Quota and storage** — Item count per Vault, stored byte count per Account, and pending-upload state.

`PRIVACY-008 MUST` The Server may store ordinary wall-clock timestamps for Server records, retention,
expiry, access, audit, and operations. User-authored Item timestamps remain encrypted. Documentation
states that the operator can observe the activity chronology; the design adds no sequence-only or
day-bucket machinery merely to obscure time.

`PRIVACY-009 MUST` Ciphertext is not padded. Ciphertext length is Server-visible.

`PRIVACY-010 MUST` A Share link is unlinkable. The Server does not learn which Item a Share link was
created from.

`PRIVACY-011 MUST` A Co-tenant User learns nothing about a Vault they are not a member of, including
its existence, and nothing about a User they share no Team with. Invitation address lookup is the
sole exception.

`PRIVACY-012 MUST` Released installed-client builds are reproducible and their signatures and content
hashes are published. These let a person verify a release artifact; they do not prove which bytes a
User ran and do not make endpoint compromise or substitution Detectable under `PRIVACY-002`.

`PRIVACY-013 MUST` Product documentation states the `PRIVACY-007` list and observable chronology in
plain language, leading with Vault, Team and Device names, email addresses, the complete membership and
role graph, sizes, source addresses, and access times as readable by the operator.

`PRIVACY-014 MUST` Server request and Operator Logs carry documented default retention bounds. They are
operator-controlled administrative evidence and never a security boundary.

`PRIVACY-015 MUST` The Web client's guarantee is per-load trust in its serving operator. That operator
ships the code that handles the master password and can serve different code to one User. The
installed-client content-secrecy promise does not apply against that serving operator. Full security
documentation and a concise non-blocking notice in the Web client's security or Account information
state this; no recurring warning interstitial is required.

`PRIVACY-016 MUST` Each release publishes the content hash of its Web client bundle. A conforming
Server serves that byte-exact bundle for the version it declares. The hash supports release and
deployment verification only: a Malicious Operator can report the expected hash while serving other
bytes, so targeted and fleet-wide substitution are both Acknowledged.

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
names are not. Every secure Web-client response sends
`Strict-Transport-Security: max-age=31536000` without `includeSubDomains` and without preload. HSTS
protects navigation after the browser has received the policy; the product does not claim it protects
the first HTTP visit. This answers the Network Attacker class.

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
encrypted server data. They cannot decrypt Vault content through a conforming installed client whose
recipient keys were verified, cannot reset cryptographic secrets, and cannot create a cryptographic
Vault grant. A Server-issued credential alone carries no decryption key. `PRIVACY-007` bounds what an
administrator sees. On the Web client, `PRIVACY-015` makes the serving operator's access to secrets
Acknowledged because that operator supplies the running code.

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

`AUTH-001 MUST` Every route to an Account's keys consumes two independent factors, and the routes are
a closed list: master password plus Secret Key; Recovery Key plus Secret Key; an enrolled Device plus
the local authorization its Device Unlock Wrapper requires. No route consumes one artifact alone. A
new route is an amendment to this requirement, not a feature, and `AUTH-029` renders this list as a
screen so an unlisted route shows up as a defect. On the first two routes one factor is human-chosen
and one is machine-generated, which is what `AUTH-020`'s entropy floor prices. ADR 0012.

`AUTH-002 MUST` OPAQUE's session key and export key have separate jobs. The session key authorizes one
Device-credential issuance and is then erased. HKDF-Expand-SHA-512 derives the 32-byte Account Unlock
Key from the export key with `bittery/opaque/account-unlock/1` as `info`; that key wraps the Account Key
Set and nothing else. Neither output is reused for the other's job.

`AUTH-003 MUST` A full sign-in is OPAQUE-3DH as specified by RFC 9807. Authentication protocol version
`0x01` fixes OPRF `ristretto255-SHA512`, 3DH over ristretto255, HKDF-SHA-512, HMAC-SHA-512, SHA-512,
and Argon2id as the application key-stretching function. The exact Argon2id parameters are named by the
key-derivation profile. Every surface uses this one protocol. The initial implementation pins
`opaque-ke` exactly at 4.0.1; crate serialization is never a persisted or public format. ADR 0006.

`AUTH-009 MUST` OPAQUE's password input is the ASCII bytes `bittery/opaque-input/1`, then the stable
Account identifier, stable Server identifier, and NFKD UTF-8 master password, each prefixed by its
unsigned 16-bit big-endian byte length, then the raw 16-byte Secret Key. Empty or longer-than-65,535-byte
variable fields and a Secret Key of any other length are rejected before OPAQUE. The Account and Server
identifiers are also the OPAQUE client and server identities; the Account identifier is the credential
identifier. Email is lookup-only. Ticket 23 must define how the stable Server identity is obtained,
pinned, restored, and changed before relay resistance can be claimed.

`AUTH-010 MUST` Every OPAQUE message and stored registration record is the one-byte authentication
protocol version, the one-byte key-derivation profile, then the RFC 9807 bytes. `0x00` is invalid in
both append-only registries. OPAQUE context is the ASCII bytes `bittery/opaque-context/1`, those two
identifier bytes, and the ASCII bytes `ristretto255-SHA512`. A mismatch fails authentication. Message
kind comes from the protocol endpoint and is not repeated inside the payload. No CBOR, delimiter-based
text, variable-length integer, or Rust-native encoding exists at this boundary.

`AUTH-011 MUST` A full sign-in authenticates Device enrolment only. Ordinary traffic uses a Device
credential. After KE3 succeeds, HKDF-Expand-SHA-512 derives a one-use confirmation key from the OPAQUE
session key with `bittery/opaque/device-credential/1` as `info`; HMAC-SHA-512 under that key authenticates
the canonical Device-credential issuance request. The Server issues the credential only in that
exchange's final atomic transaction, then both parties erase the session and confirmation keys.

`AUTH-012 MUST` One OPRF seed and one static 3DH Server key exist per Server and authentication-protocol
version. They are root authentication secrets and mandatory backup material. KE1 creates a short-lived
Sign-in attempt addressed by a random 128-bit identifier. The Server retains the OPAQUE state, Account,
both version bytes, and expiry and atomically consumes it on the first KE3 submission, success or
failure. The state is shared across Server processes through the selected authoritative abuse-state
adapter; correctness never depends on sticky routing or a non-authoritative cache. `ABUSE-003` fixes
expiry, fake-response behavior, and attempt bounds, while `ABUSE-011` keeps Redis optional.

`AUTH-013 MUST` CI runs every applicable RFC 9807 Appendix C vector plus Bittery-profile positive and
negative vectors against Rust and WASM. Independent cross-implementation testing is not a release
requirement. External cryptographic review covers the pinned OPAQUE dependency, Bittery profile, byte
encodings, integration, and Account Key Set wrapping before general availability, followed by a
penetration test of the running product. Beta may precede that review only under `CRYPTO-POLICY-006`.
The public security whitepaper, protocol documentation, ADR, and review materials state that RFC 9807
is a final IRTF Informational RFC, not an Internet Standards Track specification; routine UI does not.

`AUTH-014 MUST` Authentication-protocol versions form a client-compiled, one-byte, append-only registry
with no negotiation or automatic fallback. Devices pin the Account's version and the Emergency Kit
prints it. A migration accepts the old version until an eligible client authenticates with it or an
enrolled Device authorizes replacement, then atomically stores the new OPAQUE registration and new
Account Key Set wrapper before deleting the old pair. The User saves the updated Emergency Kit before
commit. If the old version is unsafe to execute, only an enrolled Device or an independently valid
recovery route may authorize replacement; the operator has no bypass. No alternate protocol is
pre-approved: a library failure blocks release until an RFC-conformant implementation passes the gate,
and rejection of OPAQUE reopens this decision.

`AUTH-015 MUST` A full sign-in performs exactly one memory-hard run: the Argon2id key-stretching
function inside OPAQUE. OPAQUE produces both its session key and client-only export key; `AUTH-002`
narrows and separates their uses without another password derivation. No other derivation repeats this
work unless `AUTH-020` says its human-chosen input requires it. ADR 0008.

`AUTH-016 MUST` Key-derivation profile `0x01` is Argon2id version `0x13`, memory cost 65,536 KiB,
three passes, four lanes, a 16-byte all-zero salt, a 64-byte output, and no optional secret or
associated data. These values are the RFC 9106 memory-constrained profile adapted to RFC 9807's
SHA-512 output size; clients accept no parameters from a Server. Before release, Rust and WASM on
every supported low-end client baseline MUST allocate the memory and pass the same positive and
negative profile vectors repeatedly. The design record reports elapsed time and peak memory but sets
no cryptographic wall-clock threshold; ticket 50 owns user-visible performance budgets. A capability
failure reopens either this profile or the supported baseline. Measurements and their limits are in
[the profile benchmark](../../../planning/greenfield-decision-map/research/key-derivation-profile-benchmark.md).

`AUTH-017 MUST` Key-derivation profiles form one closed, ordered registry compiled into every client.
`0x00` is invalid; `0x01` through `0xFF` are the complete finite identifier space. An admitted entry is
immutable and is never removed or reused. A higher identifier may be admitted only after the integrated
cryptographic review finds it no weaker than every lower entry on every accepted security dimension;
an incomparable construction requires a new authentication-protocol version. Each Account has exactly
one pinned profile and a migration moves directly from that entry to one higher entry, with no registry
walk, active window, retirement state, or reused identifier. ADR 0009.

`AUTH-018 MUST` A Server descriptor MAY advertise one deployment-preferred profile identifier but no
parameters. After a full sign-in, a client offers an upgrade only when that entry is compiled into the
client, greater than the Account's pinned profile, and advertised as supported by the deployment. The
User may defer without losing access and is offered the upgrade again after a later full sign-in.
Acceptance uses `AUTH-014`'s atomic replacement of the OPAQUE registration and Account Key Set wrapper,
requires the User to save the updated Emergency Kit before commit, records the new client pin only
after the Server confirms the replacement, and leaves no dual-registration or partially migrated
Server state.

`AUTH-019 MUST` The pinned profile identifier is authoritative client-carried state. An enrolled Device
stores it; trusted-device enrollment transports it; and the Emergency Kit prints it as a separate
one-byte field beside, not inside, the stable `SK1` Secret Key code. A Device with no local state MUST
obtain the pin from the Kit or trusted enrollment before KE1 and MUST NOT query a per-Account Server
endpoint, accept a Server-selected pin, or try any registry entry. A missing, stale, or unsupported pin
refuses full sign-in with recovery guidance. A descriptor preference lower than the pin or unknown to
the client is ignored and produces a persistent local security warning. Registration data inconsistent
with the pin fails authentication under `AUTH-010`; it never triggers fallback. ADR 0009.

`AUTH-020 MUST` Every derivation route that consumes any human-chosen secret performs its memory-hard
work under the Account's pinned profile. A route may use HKDF without Argon2id only when every secret
it consumes is independently machine-generated with at least 128 bits. No route owns separate
parameters, silently selects a weaker profile, or stretches a random secret merely because the route
is named recovery. ADR 0008.

`AUTH-021 MUST` The cryptographic master-password input is UTF-8 after NFKD normalization, with no
trimming and no case folding. Account creation and password change require at least 15 Unicode code
points in the entered string before normalization; the only maximum is `AUTH-009`'s 65,535-byte bound
on the normalized UTF-8 input. Clients accept spaces and Unicode, impose no composition rule or
periodic change, show an advisory strength estimate, and offer a generated passphrase. Every client
ships the same versioned common-and-compromised-password blocklist and rejects a candidate only when
the complete candidate, after NFKD and Unicode Default Case Folding, equals an entry processed the
same way. The blocklist version pins the Unicode data version used for that comparison.
There are no substring checks, contextual entries, mandatory estimator score, external lookup, or
administrator policy. The rejection comparison never changes the OPAQUE bytes. Canonicalization and
positive and negative blocklist cases are conformance fixtures. A Server cannot enforce this policy
because it never sees a master password.

`AUTH-004 MUST` Adding a Device supports trusted-device QR enrollment, master password plus Secret Key,
and the `AUTH-026` recovery sign-in. The Server alone cannot provision decryption keys.

`AUTH-005 MUST` Losing every enrolled Device, the Secret Key, and the Recovery Key is unrecoverable by
an administrator and by anyone else. The product ships no peer-held, delegated, or
administrator-assisted recovery, so `AUTH-001`'s closed list is the whole set of ways back in.

`AUTH-006 OPEN` A Recovery Key is optional, user-held, and machine-generated with at least 128 bits.
Account creation offers one and the interface keeps offering while none exists; no Server setting
requires or forbids one, because a Server cannot enforce a policy over a secret it never sees. The
Server holds the key context `0x02` envelope and one recovery authentication record, serving the
envelope only after an `AUTH-026` recovery sign-in succeeds. Ticket 09 decides the final two-factor
construction, including whether it derives a wrapping key and therefore adds a new `CRYPTO-011`
label. Whether an Account has a Recovery Key is operator-visible, and `PRIVACY-007` names it.

`AUTH-030 MUST` Revoking a Recovery Key deletes the key context `0x02` envelope and the recovery
authentication record, and writes an Operator Log entry. That ends the route for every holder
except one who already kept a copy of the envelope, which `AUTH-028` states rather than implies. The
interface offers an `AUTH-027` Secret Key rotation immediately afterwards, because rotating the second
factor is what makes a kept copy useless to anyone who never held the old Secret Key. Replacing a
Recovery Key is a revoke followed by a create; the product exposes both verbs.

`AUTH-007 MUST` Biometrics provide local authorization to use device-bound wrapping capability. They
are not Server authentication or recovery credentials.

`AUTH-008 MUST` Revocation takes effect when an offline Device reconnects. The product never claims
remote erasure of a Device that never reconnects.

`AUTH-022 MUST` The **Emergency Kit** is one sheet holding the Server address, the Account email
address, the Secret Key, the key-derivation profile identifier, and the Account Fingerprint. It
carries no Recovery Key, no master password, and no field for writing one, and it prints a line
telling the holder not to add one. A **Recovery sheet** is a separate document, produced when a
Recovery Key is created, carrying the Recovery Key and the same Account and Server identification,
with instructions to store it away from the Kit. Two documents are what keeps `AUTH-001` true inside a
filing cabinet, where one page carrying both factors would not be.

`AUTH-023 MUST` Account creation does not complete until the Emergency Kit is printed or saved and the
User confirms it. Both routes exist on every surface. The save route writes an unencrypted file and
says so where the User clicks, naming the download location as the exposure. The product ships no
passphrase-protected Kit file, because a second forgettable human secret inside the disaster path is
worse than a plain file the User is told to move.

`AUTH-024 MUST` The Secret Key is 16 bytes from a cryptographic random source, generated on the client
at Account creation, and reaching a Server only inside the `AUTH-027` Account Private Object. A
Recovery Key is generated the same way. Both are written as a version prefix, `SK1` and `RK1`
respectively, then Crockford Base32 in groups of five characters, then one Crockford check symbol over
the whole code. Distinct prefixes stop the two sheets being confused. A client validates the check
symbol before any derivation runs, so a mistyped code is reported as a mistyped code and never as a
wrong password after a slow derivation. Each sheet carries the same code as a QR for scanning. The
encoding, the grouping, and the check symbol are conformance fixtures under `AUTH-012`.

`AUTH-025 MUST` Changing the master password requires the current password on every surface, including
a Device that is already unlocked and holds the Account Key Set. Requiring it is what stops brief
access to an unlocked Device becoming a permanent lockout of its owner. The client derives the new
Account Unlock Key under the pinned profile, or the stronger profile `AUTH-018` offers, unwraps the key
context `0x01` envelope with the old key, re-wraps it with the new one, and creates the new OPAQUE
registration. The Server applies the new wrapper and registration as one atomic write or neither. No
Vault key moves or grant changes, and the key context `0x02` and `0x03` envelopes stay valid, so the
Recovery Key and every other Device keep working. The change offers signing out every other Device,
**off by default**,
because a Device the User distrusts is revoked by name and a routine password change should not
log out a phone. An Operator Log entry records it.

`AUTH-026 OPEN` Ticket 09 re-decides recovery authentication and its atomic authorization order. It
must not reuse the superseded signature challenge-response, and if it authorizes replacement of an
unsafe OPAQUE version it is an independent route under `AUTH-014`, never an operator reset.

`AUTH-027 MUST` The Secret Key is rotatable. A rotation creates a new OPAQUE registration and Account
Unlock Key, re-wraps the key context `0x01` envelope, re-wraps the key context `0x02` envelope where a
Recovery Key exists, replaces any recovery authentication record, and produces a new Emergency Kit,
as one atomic Server write or none. The current Secret Key is also held
in an **Account Private Object**, key context `0x12`, sealed to the Account's own encryption key, so an
enrolled Device picks up a rotation on its next sync rather than needing re-enrolment. Without it a
User with several Devices leaves the rotation half-done. The Server holds that object as ciphertext it
cannot read. `CRYPTO-012` requires a signed canonical payload and monotonically increasing object
generation, because HPKE Base mode alone authenticates no sender. Rotation offers signing out every
other Device, off by default, on the same reasoning as `AUTH-025`.

`AUTH-028 MUST` Rotating or revoking a wrapping secret is **forward protection only**. An adversary
holding a copy of a wrapped envelope, which operator backups contain, plus the matching old secrets,
still opens the same Account Key Set. Only a new Account Key Set ends that, and the first release
generates none, because a new key pair changes the Account Fingerprint that `CRYPTO-005` binds into
every Vault grant signature, so every granter would have to re-issue. The stated remedy for a confirmed
Account Key Set compromise is exporting into a fresh Account. Requirements, product documentation, and
the `AUTH-029` screen say this in these terms rather than implying that revocation is complete.
ADR 0013.

`AUTH-029 MUST` One screen lists every live route into the Account, built from real state: each
enrolled Device with the local authorization it uses, whether a Recovery Key exists, when the Emergency
Kit was last produced, and the two factors each route consumes. Every route is revocable from that
screen. It is generated from `AUTH-001`'s closed list, so a route the product grows without amending
`AUTH-001` is visible as a defect rather than invisible.

## Abuse defense and enumeration resistance

`ABUSE-001 MUST` Every public ceremony, credential-verification route, capability-verification route,
and authenticated write with a large availability impact declares its subject, source-address, and
Server-capacity scopes. The selected abuse-state adapter evaluates and records a scope atomically before
the protected work begins. An unavailable adapter fails the protected request closed with a temporary
service error; an endpoint cannot silently omit its declared scope.

`ABUSE-002 MUST` The Server uses the transport peer as the source address by default. It honors a
documented forwarding-header mode only when the transport peer is in an explicit trusted-proxy
allowlist; invalid proxy configuration fails startup. A request for which no source address is
available enters one shared `unknown` source scope rather than bypassing source limits.

`ABUSE-003 MUST` A full-sign-in start is limited to ten requests per normalized login subject and
twenty per source address in each fifteen-minute window. A Sign-in attempt expires five minutes after
KE1. At most three live attempts exist per login subject and twenty per source address, and the Server
also enforces a deployment-sized live-attempt capacity. A start above any bound is rejected without
evicting an existing attempt. Real and unknown Accounts use identical scopes and bounds. An abandoned
attempt consumes start and concurrency budgets but is not a credential failure.

`ABUSE-004 MUST` An unknown Account runs RFC 9807's fake-record path through the ordinary versioned
OPAQUE Server setup, with fresh per-attempt state and no persisted fake registration or second seed.
Known and unknown Accounts have the same outward status, response shape, response size class, attempt
lifecycle, and abuse treatment. Implementations keep the real and fake paths structurally alike and
test for gross timing regressions, but make no exact constant-time network-latency promise.

`ABUSE-005 MUST` A completed failed full sign-in or recovery sign-in records one failure against its
Account subject. The first five failures have no Account cooldown. Further failures permit the next
attempt after one, two, four, eight, then fifteen minutes; later cooldowns remain capped at fifteen
minutes. A successful sign-in clears the failure state, and twenty-four hours without a failure resets
it. The product creates no separately unlockable hard Account lock. A targeted attacker can keep an
Account in the capped schedule, so this denial of service remains Acknowledged under `PRIVACY-005`.

`ABUSE-006 MUST` A wrong email, master password, Secret Key, Server, OPAQUE proof, or recovery proof
produces one generic credential error that identifies no failed input. A cooldown produces the same
`429` response and `Retry-After` value for real and unknown subjects. A Server-capacity rejection uses
`503`, so clients do not treat overload as a bad credential.

`ABUSE-007 MUST` Public signup, recovery, invitation, and Share requests reveal no difference in target
existence through status, response shape, response size class, or abuse treatment. Only an authenticated
relationship check, including `PRIVACY-011`'s invitation-address lookup exception, or possession of an
unguessable invitation or Share capability may reveal target state. A public request that sends a
message or issues a verification challenge is limited to five requests per keyed subject and ten per
source address per hour unless its owning requirement chooses a stricter limit.

`ABUSE-008 MUST` A short verification code, if an owning feature introduces one, is invalidated after
five failed submissions. The subject then enters a fifteen-minute verification cooldown which survives
issuing a replacement code; replacement never buys a fresh guessing budget. Success clears the state.
Known and unknown subjects retain the same outward behavior, and source and Server-capacity scopes also
apply.

`ABUSE-009 MUST` Password change, Secret Key rotation, Recovery Key creation, replacement or revocation,
and mass Device revocation each have a separate per-Account budget of five submissions per hour,
counting successful and failed submissions, plus source and Server-capacity scopes. One operation cannot
exhaust another operation's budget, and none shares state with the credential-failure cooldown.

`ABUSE-010 MUST` Server-wide protection is a set of positive capacities for live authentication
attempts, concurrent expensive authentication work, queued abuse-state writes, and relevant database
work, not one fleet-wide request bucket. Each deployment profile ships sized defaults. Crossing a
capacity rejects new protected work with `503` before exhaustion and never evicts accepted work.

`ABUSE-011 MUST` PostgreSQL is the default authoritative abuse-state adapter. An operator may instead
select Redis or Valkey at startup; both adapters implement the same atomic scope, expiry, cooldown, and
error contract, and the Server never switches authorities while running. The Redis profile requires
persistence, a non-evicting policy, and a namespace marker. Unavailability fails protected traffic
closed. Detected state loss refuses protected traffic until an operator explicitly acknowledges
reinitialization. Redis remains optional for a conforming deployment under `HOST-002`.

`ABUSE-012 MUST` Protected scopes, the credential-failure schedule, verification-code attempt count,
and sensitive-mutation ceilings cannot be disabled or weakened by configuration; an operator may make
them stricter. Source-address budgets, concurrency bounds, and Server capacities may be set to any
positive validated value so shared networks and deployment sizes can be accommodated. Invalid or zero
values fail startup.

`ABUSE-013 MUST` Abuse state uses Account identifiers after authentication, keyed digests rather than
raw public identifiers or capabilities before authentication, and source addresses only for declared
source scopes. It stores no password, Secret Key, Recovery Key, verification code, invitation token,
Share token, or Device credential. A window, cooldown, capacity reservation, or Sign-in attempt is
deleted when its enforcement lifetime ends; longer abuse history belongs only to the Operator Log
policy.

`ABUSE-014 MUST` The first release ships no CAPTCHA, external bot provider, local proof-of-work
challenge, or unused provider interface. Subject, source, and Server-capacity controls are the complete
bot-defense surface for this release.

## Cryptographic format

### Design policy

`CRYPTO-POLICY-001 MUST` A candidate design first satisfies the accepted threat model. Among
candidates that do, prefer complete constructions standardized in final RFCs and available through
mature reviewed implementations; then prefer the smallest total implementation, protocol-state,
persisted-format, and migration surface. Performance breaks later ties and never silently weakens a
security property.

`CRYPTO-POLICY-002 MUST` A bespoke construction or primitive without a final RFC is permitted only
where a documented mandatory security property has no suitable final-RFC construction. The exception
records an alternatives comparison, mature implementation support, conformance vectors, and an
independent cryptographic review before beta. Convenience, consistency with an earlier design, and
avoiding a dependency are insufficient.

`CRYPTO-POLICY-003 MUST` Use one mechanism per security job, one canonical encoding, and one migration
path. A second primitive, registry, envelope shape, or state machine requires a recorded requirement
the first cannot satisfy. Complexity is counted across the whole product rather than justified one
ticket at a time.

`CRYPTO-POLICY-004 MUST` Use a standard protocol's complete registered mode and specified wire
semantics. Export-only use or custom recombination satisfies the `CRYPTO-POLICY-002` exception gate.
A composition is not standards-based merely because each primitive inside it has a standard.

`CRYPTO-POLICY-005 MUST` A cryptographic dependency has active maintenance, RFC and test-vector
conformance, supported WASM operation, documented unsafe code, and vulnerability monitoring, plus
either meaningful independent review or broad interoperable deployment. Bittery implements no
cryptographic arithmetic. Reducing dependency count never justifies owning a primitive.

`CRYPTO-POLICY-006 MUST` Beta may precede integrated external review only when labeled non-production
and making no reviewed-cryptography claim. Independent review of the complete design and
implementation, followed by penetration testing of the running product, blocks general availability.
The stricter before-beta exception gate in `CRYPTO-POLICY-002` still applies.

`CRYPTO-001 MUST` The key hierarchy has exactly these levels. `AUTH-002` derives the **Account Unlock
Key**, which wraps one random **Account Key Set**. That set's X25519 public key receives sealed **Vault
keys**, while its Ed25519 **Account Signing Key** authenticates grants and authored objects. A Vault
key encrypts Item revisions directly and wraps random **Attachment keys**. An Attachment key encrypts
that Attachment's chunks. Recovery and Device unlock may wrap the same Account Key Set; they do not
introduce another content-key level. No Team key opens Vault content. ADR 0011.

`CRYPTO-002 MUST` The Account Key Set plaintext is exactly a 32-byte X25519 static secret followed by
a 32-byte Ed25519 signing seed. Both are generated from a cryptographic random source at Account
creation and never derived from a password. Public keys are derived after unwrap and MUST match the
Server-visible copies before use. A Server serves the wrapped set only after the corresponding sign-in
or Device ceremony succeeds. A credential or protocol change re-wraps this one object and leaves every
Vault key, public key, Account Fingerprint, and existing grant untouched.

`CRYPTO-003 MUST` Every persisted symmetric envelope uses AES-256-GCM-SIV as specified by RFC 8452,
with a fresh uniformly random 96-bit nonce and a 128-bit tag. Devices do not coordinate nonce counters.
Nonce repetition is never intentional, but does not cause the catastrophic confidentiality and
authenticity failure of AES-GCM or ChaCha20-Poly1305. One key protects at most 2^32 envelopes and one
envelope contains at most 32 MiB (2^25 bytes) of plaintext, a joint policy inside RFC 8452's
random-nonce bounds. XChaCha20-Poly1305 and ordinary AES-GCM are absent. ADR 0010.

`CRYPTO-004 MUST` Every HPKE envelope uses RFC 9180 Base mode, including a Vault key sealed to a
recipient and the Account Private Object sealed to its own Account. The suite is
`DHKEM(X25519, HKDF-SHA256)` (`0x0020`), `HKDF-SHA256` (`0x0001`), and
`ChaCha20Poly1305` (`0x0003`). The implementation emits and consumes the registered
`enc || ciphertext` wire semantics. HPKE `info` is the exact ASCII bytes
`bittery/envelope/hpke/1`; the envelope header and binding tuple are HPKE AAD. Export-only mode,
custom exporter labels, and RSA are absent.

`CRYPTO-005 MUST` A Vault grant carries a strict RFC 8032 Ed25519 signature outside its HPKE body.
The signed canonical bytes are the label `bittery/sign/vault-grant/1`, format version, stable Server
identity, Vault identifier, key epoch, granter Account identifier, recipient Account identifier,
recipient Account Fingerprint, granted role, and the exact HPKE `enc || ciphertext`. A client accepts
neither altered policy fields nor a substituted sealed Vault key. OPAQUE authentication material never
signs product data.

`CRYPTO-006 MUST` Vault grants are flat. Every Vault key is sealed directly to each member's Account
encryption key, and no Team-wide key opens Vault content. Team membership alone therefore grants no
decryption capability, and a departure rotates only Vaults the member could open. There is no User,
Team, or Security History key; `AUDIT-001` defines one operator-readable log.

`CRYPTO-007 MUST` One **format version** byte identifies the whole cryptographic suite and byte
layout through a closed, ordered, append-only client registry. There is no negotiation, separate
algorithm field, operator choice, or downgrade path. Version `0x01` names AES-256-GCM-SIV, the
`CRYPTO-004` HPKE suite, Ed25519, SHA-256, and the layouts in `CRYPTO-008`. An unknown version is a
hard client-update outcome. The exact registry is specified in
[`cryptographic-format.md`](cryptographic-format.md).

`CRYPTO-008 MUST` Every envelope begins `format_version:u8 | key_context:u8 | key_epoch:u32be` and
then has exactly one context-selected body:

- **Symmetric:** `nonce[12] | AES-256-GCM-SIV ciphertext | tag[16]`.
- **HPKE:** `enc[32] | ChaCha20-Poly1305 ciphertext | tag[16]`.

No inner length, optional field, or trailing byte exists. The epoch is zero in a context without
Vault-key generations. A nonzero epoch selects the exact Vault key generation needed to open the
envelope; ticket 11 owns rotation lifecycle rather than this representation.

`CRYPTO-009 MUST` Envelope AAD is the complete header bytes verbatim followed by a canonical binding
tuple reconstructed from the object's typed storage location. Byte strings are `u16be` length-prefixed;
integers have their context-fixed width; field order is immutable. Every tuple starts with stable Server
identity and then binds the natural object path: Account and optionally Device for Account wrappers;
Vault, granter, recipient, fingerprint and role for a grant; Vault, Item and revision for an Item;
Vault, Item and Attachment for an Attachment key; those fields plus chunk index and total count for a
chunk; and Share-link identifier only for a Share snapshot. The epoch is already in the header. No API
may decrypt a context-free blob. A Share snapshot never binds its source Item.

`CRYPTO-010 MUST` Key contexts are a closed one-byte table: `0x00` invalid; `0x01` Account Key Set
under the Account Unlock Key; `0x02` Account Key Set under a recovery wrapping key; `0x03` Account Key
Set under a Device Unlock Wrapper key; `0x10` Vault key sealed to an Account; `0x12` Account Private
Object sealed to its Account; `0x20` Item revision under a Vault key; `0x21` Attachment key under a
Vault key; `0x22` Attachment chunk under an Attachment key; and `0x40` Share snapshot under its Share
key. The table fixes object purpose and symmetric versus HPKE body shape. Gaps are reserved, unknown
values fail, and later tickets do not reuse an entry for a different job.

`CRYPTO-011 MUST` Domain labels are a closed registry of exact ASCII bytes:
`bittery/envelope/hpke/1`, `bittery/sign/vault-grant/1`,
`bittery/sign/item-revision/1`, `bittery/sign/account-private-object/1`, and
`bittery/account-fingerprint/1`. Labels are length-prefixed where they enter canonical signed or
hashed bytes and are never NUL-terminated. This ticket adds no custom HKDF derivation. The only current
derivation label remains `AUTH-002`'s `bittery/opaque/account-unlock/1`; another ticket adds a literal
only when its accepted design actually derives a new key. CI asserts pairwise label distinctness.

`CRYPTO-012 MUST` Ed25519 signs canonical protected bytes directly, never an application-level hash
of those bytes. An Item revision signs its label, format version, Server, Vault, Item, revision number,
author, and unsigned canonical revision body; body and signature are then encrypted together. An
Account Private Object signs its label, format version, Server, Account, object generation, and
canonical Secret Key payload; that signature stays inside the HPKE ciphertext. Verification is strict,
and no plaintext from an unsigned or invalid object reaches a caller.

`CRYPTO-013 MUST` Each Attachment chunk is an independent envelope binding Attachment identifier,
chunk index, and total chunk count, so trusted streaming does not require buffering the whole file and
truncation or reordering fails. The signed Item revision also commits to its ordered Attachment
manifest: each Attachment identifier, wrapped-key envelope bytes, chunk count, total byte size, and
SHA-256 digest of every stored chunk envelope. A Vault Co-member can hold the Attachment key but cannot
replace a signed author's Attachment without detection.

`CRYPTO-014 MUST` An **Account Fingerprint** is SHA-256 over the length-prefixed label
`bittery/account-fingerprint/1`, Account identifier, X25519 public key, and Ed25519 public key. The full
32 bytes display as grouped lowercase hexadecimal and are never truncated. `CRYPTO-005` binds the
fingerprint into every grant. Public-key substitution by a Malicious Operator remains Acknowledged
unless Users compare fingerprints out of band; the fingerprint is not key transparency.

`CRYPTO-015 MUST` Before returning plaintext, a decoder rejects an unknown version or context, a
wrong context/body shape, nonzero epoch where forbidden, short or trailing data, oversized or
non-canonical tuple fields, authentication failure, public-key mismatch, invalid or non-canonical
signature, malformed or low-order public-key input, and an exceeded usage limit. All authenticity
failures map to one non-oracular outcome. A missing known Vault epoch is the only distinct recoverable
outcome, so a client may fetch its grant. No failure emits partial plaintext. Every rule has a negative
fixture and every context has positive, relocation, and wrong-context fixtures.

`CRYPTO-016 MUST` Rust manifests may use compatible ranges beginning with `aes-gcm-siv` 0.12,
`hpke` 0.14, and `ed25519-dalek` 3.0, but released artifacts resolve exact versions through a committed
lockfile. Automated updates open reviewable changes and never auto-merge. Each update runs the RFC,
Wycheproof, and Bittery fixture corpus; changed cryptographic code receives proportional security
review before release. Independent targeted review of the pinned AES-256-GCM-SIV path blocks beta,
and `CRYPTO-POLICY-006` still gates general availability on integrated review and penetration testing.

`CRYPTO-017 MUST` Writers emit only the one current format. Readers accept every version compiled
into their closed registry. A format transition is one explicit, resumable, idempotent
decrypt-validate-reencrypt migration. Bittery never dual-writes formats, negotiates algorithms, or
allows a Server to select a suite. Unknown versions are preserved but not opened until a supporting
client is installed.

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

`AUDIT-001 MUST` The product has one Operator Log, readable by administrators and limited to the
`PRIVACY-007` Operator Log fields. It records administrative, operational, security, membership, Vault
grant, Share-link, and session events with configurable retention. A Malicious Operator can alter or
delete it, so no Prevented or Detectable security guarantee depends on the log.

`TRAVEL-001 MUST` Travel mode securely evicts disallowed Vault ciphertext, indexes, and accessible
keys after policy receipt. It makes no impossible promise about Devices that remain offline or storage
forensics/backups.
