# Remote unlock combines separately sourced secrets

Status: accepted

`AUTH-001` used to say the master password and Secret Key “jointly protect account encryption,” then
defined recovery artifacts that could defeat the claim alone. Its first repair called every route
“two independent factors.” That was still wrong: Recovery Key and Secret Key are both machine-generated
secrets, not different authentication-factor categories.

Bittery instead names a closed list and states the security rule each kind of route can actually meet.
A remote route combines two separately sourced secrets intended for separate storage: master password
with Secret Key, or Recovery Key with Secret Key. A local route combines an enrolled Device's held key
with the local authorization required by its Device Unlock Wrapper. Adding a route requires amending
the list rather than quietly weakening it.

The entropy-only alternative, allowing one 128-bit Recovery Key to stand alone, was rejected because
it answers guessing and ignores theft. A photographed recovery sheet would open the Account. The
product therefore emits the Emergency Kit and Recovery sheet separately, never offers a combined
artifact, and tells the User to store them apart. It can guarantee its outputs and guidance, not the
User's physical storage.

No scalar “strength” score can compare a password, two printed random secrets, and platform-local
authorization honestly. The Account-access screen instead names every route's required inputs, live
state, compromise conditions, dates, and available actions. A route absent from that screen is a
product defect.

## Consequences

A Recovery Key alone opens nothing. Losing the Emergency Kit disables both remote routes, which is why
Account creation cannot finish until the Kit is saved or printed. Ticket 12 must preserve the local
rule: Device state without its configured local authorization cannot become a fourth route.
