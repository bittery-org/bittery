# Connected native selective Travel policy propagation

Type: research
Status: resolved
Blocked by: 68, 79, 86, 87
Spec: ../desktop-extension/native-travel-policy.md

## Question

How does a verified Desktop Travel change selectively retire hidden Vault authority in a connected
Extension Runtime while preserving unrelated Vault access, local accepted work, Desktop Lock/EOF
authority and generation-bound transfer, including stale or missed controls and interrupted erasure?

## Evidence and recommendation

The [focused specification](../desktop-extension/native-travel-policy.md) traces two existing
Account-wide retirement triggers: changed source key generation and false key authorization during
selective cleanup. It also records actual writer-time snapshot/wake coalescing, which makes a latest
policy field insufficient to conserve an intermediate hide before disable.

Recommend bounded acknowledged restrictions in the existing native channel, admission into the
consumer's existing durable retirement journal, and explicitly nonexpanding continuation of an
already installed grant. Original import bindings remain immutable; hard Lock/EOF still retire the
Account. The document identifies the concrete proof, acknowledgement and pending-reason refinements
for coordinator/independent review. This research does not authorize a second policy owner, a silent
grant rebind or implementation.

## Comments

2026-09-09: claimed at the coordinator's request after71 source inspection found that selective
source key-generation retirement currently locks the consumer Account. All listed prerequisites
are resolved. Existing71 incoming-policy/proof work continues; its connected selective acceptance
waits for this frontier to be resolved. No implementation, build or acceptance is claimed.

The source evidence establishes a missing capability, not a reason to reopen68's accepted transfer
matrix or silently weaken its generation guards. Existing97 protocol1 remains coarse during the
migration; selective connected protocol2 acceptance belongs to71 and subsequent Extension hosts.

2026-09-09 refinement for independent review: the first selective fence, retained batch and source
generation classification are atomic under existing native-state/publication ordering. Bounded
exact digest replay and contiguous ACKs survive lost delivery after local journal cleanup without
another durable receipt. Captured destination incarnations prevent old controls targeting a re-added
Account. Hard Lock/removal keeps known cleanup duties even though grants retire. The existing pending
owner distinguishes Server/native reason revisions behind its one conservative durable bit.

Account-scoped grants retain their existing new-Vault behavior through monotonic exclusions, with
explicit per-channel/owner bounds. The coordinator accepted a provenance-preserving independent
restoration purpose in the existing native challenge owner: source visibility plus consumer current
policy/fresh authority, no borrowed Session installation or new user gesture. Borrowed grants still
require fresh ordinary transfer. The focused record/ACK/lifetime contract is now awaiting independent
final review; research remains claimed and connected71 implementation remains held.

2026-09-09 resolution: coordinator and independent final review accepted the complete focused
contract. The six concrete gaps above are closed, including exact replay after journal cleanup and
independent authorization-only restoration. Simplification keeps one existing native channel/grant/
challenge owner plus common retirement and pending owners; no new durable receipt or policy cache.
All11 local links in the focused spec/ticket and `git diff --check` pass. Research is resolved;71
owns implementation and actual connected selective acceptance. No build or acceptance was performed
for this documentation research.

Resolution precision: live port/channel loss preserves observed precommit proof while its Runtime
survives. Actual process loss before the retirement commit loses transient evidence and had no ACK
or durable-erasure claim; process loss after physical commit resumes the existing journal even if
commit/native acknowledgement was lost. The focused contract distinguishes those tests explicitly
without introducing native persistence.

Implementation preparation found the initial-attachment counterpart: an independently unlocked
consumer may attach after Desktop finished hiding a Vault. The coordinator accepted a bounded
baseline from existing enforced Retiring/Retired scopes, captured before first delivery under the
same native/publication/registry order. Closed ExistingRetirement evidence admits only consumer
revocation/journal work; it does not invent a prior transition or consult display metadata for
authority. Initial attachment is added to the next tracer matrix. This is a routine refinement of
the same owner, not a current-policy cache or acceptance claim.

The first public/physical71 tracer reproduced the defect: public RefreshTravelMode, actual source
snapshot and consumer ApplyAuthority made the matching consumer Locked instead of retaining its
unaffected Vault (`/tmp/bittery-native-travel-selective-first-red.log`, one failing test). This is
implementation red evidence, not acceptance. Coordinator refinement preserves an overlapping local
retirement's exact existing lifetime and proof: native adoption waits for its journal, does not
replace it or infer completion from equal IDs, and a post-readmission hide is new work. Fresh transfer
also waits for its required native restriction adoption before importing authority or clearing
exclusions. The focused matrix includes overlap, lost ACK and new readmission cases.

Coordinator clarification for the following idempotence variant: repurging an unfiltered staging row
under the same enforced Vault lifetime is maintenance, even if verification produced a newer policy
timestamp. Existing registry lifetime capture distinguishes it from actual readmission and avoids
spurious native batch growth. No additional policy owner or product choice is introduced.

The coordinator accepted carrying the channel frontier/digest once on the enclosing authenticated
snapshot rather than copying it into every Account interval. Full retained-prefix validation and
all local selective fences precede nonexpanding grant continuation. This is separate from durable
adoption: exact journal/captured dispositions advance ACK and guard fresh import. Tampered interval/
prefix mixing and unrelated Account continuity are explicit acceptance variants.
