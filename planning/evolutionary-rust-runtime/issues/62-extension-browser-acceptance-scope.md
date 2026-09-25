# Extension browser acceptance scope

Type: grilling
Status: resolved
Blocked by: 41

## Question

Does this production migration retain ticket 41's Chrome 116+ scope, with Firefox and Safari
explicitly remaining unimplemented roadmap hosts?

## Existing decision

Ticket 41 already selects one combined Runtime/Crypto Worker in a Chrome offscreen document,
IndexedDB, and a service-worker broker. A recycled broker reattaches to the surviving owner; actual
owner loss starts locked. That placement and lifecycle decision is not reopened here.

The current Extension package has a Chrome MV3 manifest and Chromium acceptance harness. Ticket 41
explicitly requires separate manifests and real-host acceptance before Firefox/Safari support can
be claimed. A generic WebKit browser run cannot establish Safari Extension acceptance.

## Accepted answer

Retain Chrome 116+ production acceptance for this migration, including actual broker restart and
owner loss, autofill/passkeys, and native messaging. Keep Firefox/Safari documented roadmap hosts
without a new support claim. Record the browser version actually tested separately from the minimum
manifest version.

## Comments

2026-09-08: maintainer accepted Chrome 116+ production acceptance, with Firefox/Safari remaining
roadmap hosts. No additional browser implementation or support claim is included in this migration.
