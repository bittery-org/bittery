# Threat model and server-visible plaintext

Type: grilling
Status: resolved
Blocked by: none

## Question

Define what Bittery promises, against whom, and exactly what the Server is allowed to learn.

The corpus asserts zero knowledge in `PROD-FOUNDATION-003` and `ADMIN-001` before anything defines it. `ITEM-003` lists what is encrypted and stops. Nothing enumerates the plaintext the Server necessarily holds: Item and Vault identifiers, ciphertext length, revision counters, timestamps, the per-Vault access graph, the Sync event stream, tombstones, Attachment counts and sizes, Share-link existence, and audit records. See [corpus review, Critical #1](../research/corpus-review.md).

Decide:

- The adversary list and what each is assumed to control: honest-but-curious operator, malicious operator, network attacker, device thief, compromised client build, other Users on the same deployment.
- A closed `PRIVACY-*` field list of server-visible plaintext, with an explicit rule that anything not on the list is encrypted.
- Whether audit records name actors and objects in plaintext, or only in ciphertext the operator cannot read.
- Whether ciphertext length is padded, and to what granularity.
- What the product says out loud about the metadata it cannot hide.

Produces: a `PRIVACY-*` requirement family in `docs/greenfield/target/product.md`, an ADR if the padding or audit decision is hard to reverse, and glossary terms for the adversary classes.

## Answer

Promoted to [`PRIVACY-001` through `PRIVACY-014`](../../../docs/greenfield/target/product.md),
amended `ADMIN-001`, `ITEM-003` and `AUDIT-001`, three ADRs, and a new
[`CONTEXT.md`](../../../CONTEXT.md) glossary.

**Six adversaries, one per class.** Curious Operator, Malicious Operator, Network Attacker, Device
Thief, Co-tenant User, Compromised Client Build. The deployment archetype the design is priced
against is the organisation admin over employees, because that is the case where the User cannot
walk away. A personal deployment where operator and User are the same person then costs nothing.

**Three honesty tiers replace the unfalsifiable claim.** *Prevented*: reading Item content, and
forging a Vault grant a client accepts. *Detectable*: silent Device enrollment, unsigned membership,
rollback to older Server state, and dropped or reordered Item revisions. *Acknowledged*: denial of
service, withholding data, Server equivocation between two Devices of one Account, and everything on
the plaintext list. `ADMIN-001` now says which of its verbs means which tier.

**Server-side authorization is not a secrecy boundary.** `PRIVACY-003` makes a grant mean that a
member wrapped the Vault key, so the Server's access-control records bound abuse and protect
availability, never confidentiality. This is the largest structural consequence and lands on tickets
22 and 29.

**The plaintext list is closed and CI-enforced.** `PRIVACY-007` enumerates it; `PRIVACY-006` makes
any unnamed plaintext column a defect and requires a schema check that fails on one. ADR 0001 records
why an advisory list was rejected.

**Readable by deliberate choice:** Vault names, Team names, Device names, email addresses, and the
full Vault membership graph. Administrators need them, and `PRIVACY-013` requires documentation to
lead with Vault names, the field Users most assume is protected.

**No stored wall-clock time.** `PRIVACY-008` removes creation and modification timestamps from Items,
Vaults, and Attachments. Ordering is a per-Vault sequence number; real times sit inside the
ciphertext; retention gets a day-resolution bucket and nothing finer. ADR 0002 exists mainly to stop
a future engineer restoring `updated_at`. The matching leak is Server request logs, so `PRIVACY-014`
bounds their retention and ticket 25 sets the default.

**No padding.** Ciphertext length stays visible and documented, rather than paying padding complexity
for a partial defence the product does not otherwise promise.

**Audit splits in two.** Operator Log readable by administrators, carrying Account identifier and
event category only. Security History encrypted to the owning User or Team, carrying actor, Vault,
Item, and object. ADR 0003. Ticket 27 keeps the taxonomy and retention questions.

**Per-Item revision chaining is a new obligation** the corpus did not have, chosen over the cheaper
account-level rollback detection alone. It lands on tickets 19, 21 and 24, each of which now carries
a note about what it must solve: chain behaviour across Conflict copies, and chain preservation under
retention pruning.

**Disclosure is documentation only.** No in-app screen and no signup interstitial. `PRIVACY-013`
keeps the wording obligation; the documentation surface fog entry on the map owns where it lands.

Notes appended to tickets 10, 19, 21, 22, 24, 25, 27, 29 and 30. Ticket 05 inherits the Web client
delivery half of the Compromised Client Build class, and ticket 20 inherits the search-index leakage
question, both already in their bodies.


### Amended by ticket 08, key hierarchy and canonical envelope format

`PRIVACY-001` grew from six adversary classes to **seven**. Signing Item revisions and Vault grants
defends against a legitimate member of a shared Vault acting outside their remit, whom the six classes
had no name for; `PRIVACY-011`'s Co-tenant User is explicitly someone you share nothing with, so it
could not be stretched to cover them. The class is **Vault Co-member**, and it arrived with its two
controls (`CRYPTO-005`, `CRYPTO-012`) already decided.

`PRIVACY-004` lost two entries to `PRIVACY-003`'s Prevented tier. `CRYPTO-009` binds an object's
identity into the additional authenticated data of its envelope, so relocating ciphertext between
Items and substituting one revision for another now fail to decrypt rather than being noticed
afterwards. Dropping a revision stays Detectable through the revision chain.

`PRIVACY-007` gained three fields: the wrapped Account Key Set on an Account, a granter identifier and
grant signature on every wrapped Vault key, and a wrapped Team History Key per reader. `PRIVACY-006`
makes the list closed, so each is a deliberate amendment.

## Reopened 2026-08-20

The consistency audit found that the promoted threat model overclaims and is incomplete:

- `PROD-FOUNDATION-003` still promises undefined "zero knowledge" while `PRIVACY-007` deliberately
  exposes identities, names, membership, sizes, access patterns, and source addresses.
- `PRIVACY-016` calls fleet-wide Web bundle substitution Detectable by a third party, while
  `PRIVACY-002` defines Detectable as the User's own client catching and reporting the attack. A
  malicious Server can also report the published hash while serving different bytes.
- The closed plaintext list omits state already required for Sign-in Challenges, Device credentials,
  protocol versions, authorization, invitations, rate limiting, Server identity, and idempotency.
- Compromised Client Build does not state the disposition of malware, a compromised browser or OS,
  runtime injection, or an unofficial malicious build.
- `PRIVACY-005` says five Acknowledged attacks and lists six.

Resolve again before ticket 53 sets the cryptographic acceptance policy. The new answer must use
claims that a conformance test or a named detection mechanism can actually prove.

## Decisions in reopened pass

- **Top-level operator guarantee:** use a precise content-secrecy promise. A conforming installed
  client prevents an operator from decrypting Vault content. Do not use "zero knowledge" as the
  product or specification umbrella term. State Server-visible data and the weaker Web-client trust
  model as separate, explicit limits.
- **Detectable means client-detected:** the User's own conforming client must catch and report the
  attack. Published build hashes are release-verification data, not evidence of what a serving
  operator delivered to a User. Fleet-wide and targeted Web bundle substitution are both
  Acknowledged unless a later independent mechanism gives the User's client a real detection path.
- **Plaintext registry lifecycle:** keep a field-level closed allowlist, but mark it provisional while
  Wayfinding is open. Every downstream ticket that introduces Server-readable state must amend it
  explicitly. Freeze the registry only after the public protocol and Server schema close, then make
  the schema check release-blocking.
- **Endpoint-compromise boundary:** protect persisted secrets against a Device Thief while the Device
  is locked. Malware, a compromised OS or browser, runtime injection, and an attacker controlling an
  unlocked client are Acknowledged. Build reproducibility is a supply-chain verification property and
  is not presented as resistance to a compromised running endpoint.
- **Readable names:** Vault, Team, and Device names remain Server-visible plaintext. This is accepted
  to keep administration, support, membership management, and protocol behavior simple. Operator
  disclosure must name these fields prominently rather than burying them under the content-secrecy
  promise.
- **Readable relationship graph:** the Server may read complete Vault and Team membership and roles.
  Server authorization uses it for availability and abuse control; cryptographic grants still decide
  who can decrypt. Documentation must disclose the graph plainly.
- **Operational timestamps:** the Server may store ordinary wall-clock timestamps for Server records,
  retention, expiry, access, and operations. User-authored Item timestamps remain encrypted, but the
  observable activity chronology is disclosed. Do not build special sequence-only or day-bucket
  machinery merely to obscure time.
- **No ciphertext padding:** exact ciphertext and Attachment sizes remain Server-visible and are
  documented. The persisted format carries no padding buckets, padding policy, or padding migration.
- **One audit system:** keep one operator-readable audit log for administrative and operational
  events. It is evidence controlled by the operator, not a security boundary. Do not create a second
  encrypted Security History or a Team History Key; client detection must come from authenticated
  protocol state.
- **Rollback floor:** each client remembers the highest authenticated Item revision it has accepted
  and rejects older state. Do not require a per-Item revision chain. A revision never shown to any
  client may be withheld without detection, matching the Acknowledged withholding limit; cross-Device
  equivocation remains Acknowledged unless a later transparency design changes it.
- **Disclosure surfaces:** state the Web client's weaker serving-operator guarantee in full security
  documentation and in a concise, non-blocking notice in the Web client's security or Account
  information. Do not hide it in documentation alone or require a recurring warning interstitial.
- **Recipient-key authentication:** before the first Vault grant, an installed client requires the
  sender to compare or scan the recipient's Account fingerprint out of band. A changed key requires
  verification again. Do not claim malicious-operator content secrecy for an unverified recipient key,
  and do not build key transparency in the first release.
- **Cryptographic authorship:** use one Account-level signing key for Vault grants, role changes, and
  Item revisions. Clients validate an action against the signed role state and reject unauthorized
  actions. Do not introduce per-Device signing keys merely for finer attribution; ticket 08 must
  choose a standard signature scheme and specify Account signing-key lifecycle and history.
- **Adversary taxonomy:** use seven explicit classes: Curious Operator, Malicious Operator, Network
  Attacker, locked Device Thief, Co-tenant User, Vault Co-member, and Compromised Endpoint. A poisoned
  build is one route to endpoint compromise; reproducible-build checks remain verification controls,
  not a separate runtime guarantee.
- **Guarantee tiers:** retain Prevented, Detectable, and Acknowledged with strict meanings. Prevented
  means the attack cannot succeed against a conforming client. Detectable means that client catches
  and reports it. Acknowledged means Bittery neither prevents nor reliably detects it and documents
  the limitation.

## Answer to reopened pass

Resolved again on 2026-08-20. The promoted requirements now promise **content secrecy** for conforming
installed clients using verified recipient keys, never undefined "zero knowledge". The seven-adversary
model and strict three-tier vocabulary are in `CONTEXT.md` and `PRIVACY-001` through `PRIVACY-005`.

The plaintext registry remains field-level and closed but provisional until the protocol and Server
schema freeze. Names, email, the complete membership and role graph, sizes, source addresses,
operational timestamps, and activity chronology are deliberately Server-readable and prominently
disclosed. Ciphertext remains unpadded.

One operator-readable log replaces the encrypted Security History. It is never a security boundary,
which removes the Team History Key. Clients remember accepted authenticated revisions rather than
maintaining a per-Item revision chain. Account-level signatures remain required for grants, role
changes, and Item revisions. The first recipient key is verified out of band; first-release key
transparency is rejected.

Web substitution is Acknowledged whether targeted or fleet-wide. Published hashes verify release
artifacts but do not prove what a Server delivered. The Web limitation is documented and shown in a
non-blocking security/account notice. Locked Device theft is in scope; a Compromised Endpoint is
Acknowledged.

Promoted to `PROD-FOUNDATION-003`, `PRIVACY-001` through `PRIVACY-016`, `ADMIN-001`, `AUDIT-001`,
`CONTEXT.md`, amended ADR 0001, and new ADRs 0015 and 0016. ADRs 0002 and 0003 are superseded.
