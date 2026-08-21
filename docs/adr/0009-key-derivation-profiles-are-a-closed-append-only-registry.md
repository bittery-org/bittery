# Key-derivation profiles are closed, monotonic, and client-carried

Status: accepted

Every client compiles the same finite registry: `0x00` is invalid and immutable entries `0x01` through
`0xFF` are never removed or reused. A higher identifier is admitted only when integrated review finds
it no weaker on every accepted security dimension. A construction that cannot be ordered that way
requires a new authentication-protocol version rather than a misleading profile number.

The Account's pinned profile is authoritative client-carried state. Device state, trusted-device
enrollment, and the Emergency Kit carry it as a field separate from the Secret Key. A fresh Device
never asks the Server which profile belongs to an Account and never walks the registry. This prevents
an account-existence oracle, makes derivation work constant, and stops a malicious or stale Server
from choosing weaker parameters. The cost is explicit: a standalone Secret Key or stale Emergency Kit
is insufficient for fresh full sign-in.

A Server descriptor may advertise one deployment-preferred identifier, without parameters, solely to
coordinate upgrades. A client offers it after full sign-in only when it is compiled, greater than the
pin, and supported by the deployment. The User may defer. Acceptance atomically replaces the OPAQUE
registration and Account Key Set wrapper after the User saves the updated Kit, then records the new
client pin after confirmation. A lower or unknown preference is ignored with a persistent local
warning; inconsistent registration data fails sign-in without fallback.

## Considered options

**An exhaustive or bounded registry walk** was rejected. An exhaustive walk grows without a useful
operational bound, while a fixed window eventually strands an Account outside it. The reopened design
also proved that walking only downward misses a valid pin newer than a Server's false preference.

**Serving a per-Account profile from the Server** was rejected because it reinstates an account-
existence surface and makes an untrusted value part of pre-OPAQUE correctness.

**Retiring or reusing entries** was rejected because an old dormant Account still needs its exact
parameters; reuse can reinterpret the same byte as different cryptographic input.

## Consequences

Profile additions require coordinated client and Server releases. One Account occupies one entry and
one atomic migration moves it directly to a higher entry; there is no active window, dual registration,
retirement state, or registry search. All full-sign-in surfaces permanently retain support for every
admitted profile used by an Account they support.
