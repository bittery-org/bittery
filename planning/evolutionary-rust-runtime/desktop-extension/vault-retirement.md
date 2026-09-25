# Durable Vault authority retirement

Ticket: [87](../issues/87-durable-vault-authority-retirement.md)

## Resolved frontier

How can verified Vault absence or hidden-Vault policy erase all local authority across separate
Replica and Session stores without losing accepted work or pretending those stores commit atomically?

Use one guarded Core retirement transition and an idempotent cleanup journal in existing Replica
metadata. This implements accepted [65](../issues/65-hidden-vault-durable-work-contract.md), alongside
[86's selective capabilities](selective-vault-capabilities.md). It adds no host policy, new scheduler,
login secret or cryptographic format. The Runtime owns the proof, publication fence and cleanup;
SQLite/IndexedDB execute generated plans and platform storage executes guarded credential writes.

Inspection found that Bootstrap promotion only changes the active pointer, leaving prior-generation
Vault keys and Item rows. Its prepared commit currently forbids overlay changes. Item outcome
validation also reads category only from the optimistic overlay. Erasing that overlay without a
minimal accepted-work witness can fail a valid retained Move into a still-visible Vault. These are
actual ownership gaps; active-list filtering and historical ticket completion do not resolve them.

## Pure Replica contract

Keep a default-empty, sorted unique `pendingVaultRetirements` list in the logical Replica snapshot.
Persist it as a separate closed `vault-retirements` record in the existing Replica metadata store,
omitted when empty. Entries contain only Vault IDs. Account/incarnation/revision guards fence
completion; no per-step flags are needed because all cleanup steps are idempotent. Existing
Bootstrap control records remain byte-shape compatible and no physical table/store is added.
Recovery retains and strictly validates the journal independently of rebuildable Bootstrap control.

This placement resolves an additional recovery frontier found during implementation: placing an
essential duty inside the otherwise rebuildable Bootstrap payload would make ordinary Bootstrap
control corruption destroy proof of whether cleanup was pending. Preserve existing re-Bootstrap
recovery for that corruption by separating the essential record. A malformed retirement record
remains available for raw protected export and cannot be silently treated as an empty journal.

One domain helper removes the selected Vaults and their Item authority from every generation,
removes unnecessary optimistic overlays and protected Share capabilities, and merges the journal.
It abandons any pre-retirement staging chain that could publish removed authority. Full verified
Bootstrap promotion and a closed `RetireVaults` plan for verified current policy reuse this helper.
Promotion derives absence from old known Vault identities versus the complete new authority; Runtime
also accounts for retained Session key identities that have no cached row. A retained Delete outcome
alone never proves current absence and cannot restore or erase newer authority.

Preserve every accepted Operation, original immutable HTTP bytes/fingerprint, receipt, Attachment
Move preparation and indispensable encrypted artifact dependency. Determine affected work through
one typed helper: the target for ordinary work, both exact source and destination Vaults for Move
and its preparation/recovery. An overlay for a Move touching a retired source is erased even if
its destination remains visible. Current authoritative data for that same Item ID in a different
visible Vault survives. Share capability ownership comes from its accepted Operation or retained
receipt, never a guessed current Item location.

Retain an optional typed `acceptedItemCategory` witness with Item Operations and Attachment Move
preparations. New admission records the already validated category; affected older work backfills
it from the exact owned overlay before erasure. Validate agreement wherever both evidence forms
exist and propagate it through preparation, final Operation and reactivation. The witness changes
no request bytes or encryption. Outcome validation uses it, with the existing overlay as a legacy
fallback. Never retain decryptable overlays merely to recover this non-secret fact.

`CompleteVaultRetirements` removes only the captured pending IDs under the current guarded revision
after all external cleanup succeeds. Failure or restart keeps the duty. A later retirement cannot
be completed by an earlier stale plan. No pending Vault is readable, eligible for new work, or
eligible for resumed transcryption. Accepted exact ciphertext dispatch and retained outcome
reconciliation continue where they need no retired key.

Completion uses one exact-head guarded execution; it must not use a helper that recomputes the
revision and retries an old drain result. Retirement, re-admission and another retirement of the
same Vault must not let the first cleanup clear the later duty. Bootstrap persistence emits witness
updates and overlay/Share deletions in the same commit as authority/journal changes, validating all
other work rows rather than merely relaxing the existing non-authority equality checks.

## Runtime and Session contract

Under the existing Account ownership fences, retire affected plaintext publications and selective
foreground/file/image access, commit the purge/journal, prune wrapped Vault-key entries from the
effective Session and any dormant independent Session, then complete the journal. Existing file and
artifact owners erase unnecessary resources and retain only dependencies of accepted work. Other
Vaults and Accounts continue; this is not Account lock or teardown. The existing Runtime driver
resumes incomplete cleanup with bounded retry. Before new Bootstrap, unlock publication or restored
owner access, replay existing pending cleanup rather than treating an absent row as completed work.

Borrowed Session replacement uses exact grant identity, entire expected Session, current channel and
Account generation under the existing native-authority owner. Independent replacement compares the
entire expected document under the Account execution fence before storing. Both preserve provenance;
a borrowed document never enters platform storage. Stale refresh results cannot reinstall pruned
wrapped keys. Retain Session authentication fields, Quick Unlock material, Account master unlock key
and encrypted private-key envelope when still needed for other visible Vaults. No hidden Vault key
may be cached separately by a host.

Re-admission requires fresh verified current authority after pending cleanup completes and opens a
new target generation through 86. Old file scopes, delayed Bootstrap pages, old receipts and old
Session clones cannot revive the retired generation. A Vault becoming visible again needs fresh
wrapped-key authority. This specification does not decide Travel command lifetime (81), nor does
it authorize inferring that choice.

Native transfer needs a source-only key-authorization generation in addition to Account lock epoch.
Core advances it when retiring source Vault-key authority, without locking Desktop. The existing
native registry owns this non-secret generation, scoped by Runtime owner and Account incarnation;
source Account authority and import challenges carry it outside unchanged cryptographic material.
Export and final source encoding compare the current value. Destination matching compares source
scope and generation, retires an older borrowed grant through the existing owner, and never falls
back automatically to dormant independent credentials. Fresh authorization uses a new challenge
after cleanup and current authority are ready. Ordinary snapshot delivery sequence cannot replace
this generation: it would revoke valid grants on unrelated snapshots.

Invalidating an Account delivery token alone is insufficient because delayed native encoding can
otherwise acquire its replacement token. Generation comparison fences that queued reply and a
delayed transferred reply after newer source authority reaches the destination. The transport must
deliver source changes promptly and preserve its Core ordering checks; a remote owner cannot learn
about a revocation before its delivery. Tests distinguish this communication boundary from stale
reply acceptance after the destination has already received the new state. Prepared plaintext
deliveries still use the existing token invalidation/drain while new filtered publications continue.

Ticket 87 delivers the pure Replica/witness and guarded Session foundations. Tickets 70/71 integrate
86's actual capability drains, Runtime publication/retry and current-authority re-admission before
production activation. Foundation closure is not complete erasure or application acceptance.

## Observable checks

Start at the existing guarded Replica persistence seam: refresh from two Vaults to one, with old and
staged generations and accepted Move work. Before the implementation this retains hidden rows;
afterward all selected authority/overlays/capabilities are absent, exact accepted work survives,
and pending cleanup survives reload. Cover SQLite and generated IndexedDB histories, failed commit,
stale completion, another Account, same Item ID now in a visible Vault and explicit policy retirement.

Then verify the Runtime outcome seam: erased overlay plus retained category witness reconciles the
original Move against valid present destination authority; a mismatched category still fails closed.
Verify stale independent and borrowed Session replacements cannot resurrect removed wrapped keys.
Recovery round trips preserve the journal and indispensable work. Independent review and
simplification precede capability closure. Real Desktop/Chrome Travel/delete/lock/restart acceptance
and both full root checks remain later required gates; mocks or compilation do not establish them.
