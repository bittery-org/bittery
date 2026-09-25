# Legacy Extension compatibility after Desktop Runtime activation

Type: research
Status: resolved
Blocked by: 60, 61, 64
Spec: ../desktop-extension/native-legacy-compatibility.md

## Question

How does the sole Desktop Runtime preserve every currently consumed protocol1 native response until
Extension cutover76, without keeping legacy Desktop storage/decryption, exposing private data through
ordinary Runtime projections, or fabricating a protocol2 destination Runtime?

## Accepted boundary and evidence

The accepted Desktop-first order and68's [native transfer contract](../desktop-extension/native-transfer.md)
already require preserving the old Extension adapter until76. Actual production
`apps/desktop/src-tauri/src/lib.rs` still answers status/accounts, Session token, wrapped Vault keys,
full decrypted Item snapshots and biometric one/all through legacy `store.json`, published key refs
and native cache crypto. The implemented protocol2 source capability does not implement these old
requests. Activating66 while retaining those handlers would violate its single-owner closure.

Actual Extension `desktop-snapshot.ts` preserves every private decrypted Item field, including passkeys;
`desktop-key-material.ts` and `native-messaging.ts` consume wrapped MUK, Device key, Session and Vault
keys for its existing local owner. Mapping95's ordinary public projection would silently remove
behavior. Protocol1 has neither a destination Core generation nor a Server URL in Account entries;
it cannot be described as protocol2 import with a made-up destination identity.

The [reviewed contract](../desktop-extension/native-legacy-compatibility.md) inventories the generated
wire, consumers, guarded source-only compatibility disclosure and acceptance/removal boundary.
Reuse Core native authority, current private Item reading/formatting and local biometric ceremony.
The native binary remains authenticated framing and opaque delivery. No Desktop Session/MUK mirror,
host decryption, new credential owner or ordinary private projection is proposed. Delivery is reserved
as [97](97-runtime-legacy-native-compatibility.md), after independent concrete review.

## Comments

2026-09-09: coordinating review authorized research96 and delivery97 for this mandatory preservation
frontier. This is not a new compatibility period: the existing staged Desktop/Extension order already
requires this adapter, and76 removes it at its atomic caller cutover. Research remains claimed pending
review;97 remains needs-triage. No production implementation, acceptance,66 dependency or status change
is claimed. Supported-OS prompts and actual Tauri production gestures retain their existing73 gates.

2026-09-09 coordinating and independent source reviews resolved this frontier. Preserve the actual
protocol1 wire through a closed legacy source mode in the same Core native authority until76.
Reuse95's private Item reading/formatting and67's local biometric ceremony; ordinary renderer
projections remain public. Exact effective-row filtering preserves trash/overlay behavior and
offline reads do not gain an online Session-validation requirement. The existing native-host loop
must observe browser EOF while requests are held and bound its output queue. The old Extension's
single transport lifetime must fence replies and nested material writes, drain before existing C1
cleanup, and protect successor publications from stale failure cleanup. These routine corrections
preserve the accepted staged migration without duplicating Account or cryptographic policy.
Delivery97 is ready with incomplete dependencies and now gates66 activation. No implementation,
actual old-consumer acceptance or supported-OS acceptance follows from this decision.
