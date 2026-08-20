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

