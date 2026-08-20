# The Web client is bound to the Server that served it

Status: accepted

Reconfirmed by Wayfinder ticket 05 on 2026-08-20.

`ACCOUNT-001` let one client hold Accounts from several independent Servers, and `ACCOUNT-003` and
`ACCOUNT-006` built All Accounts and cross-Server Collections on top. Applied to the Web client that
means a page served by Server A holds Server B's Vault keys. Server A's operator takes Server B's
secrets by changing the code they ship, and Server B's operator has no say and no visibility. Running
your own Server stops protecting you the moment another Server serves the page. `ACCOUNT-001` now
restricts multi-Server to installed clients: released, signed Desktop and Extension builds, which come
from a published artifact rather than from any one Server.

## Considered options

Allowing multi-Server on the Web client behind an explicit warning was rejected. A warning does not
undo the fact that one operator's compromise then reaches every Server configured in that browser,
and it makes `PRIVACY-016`'s Detectable framing meaningless across a Server boundary.

A single project-operated Web client origin, which every deployment would connect to, was considered
and rejected. It solves the cross-operator problem by moving the trust to one party, but it makes the
project an operator with more reach than any single Server operator has, over every user of every
deployment. It also contradicts `PROD-FOUNDATION-001` and `HOST-006`, breaks air-gapped and offline
deployment entirely, collides with the browser Local Network Access permission prompt that Chrome and
Firefox now show before a public origin reaches a private address, and turns a lapsed domain into a
mass-compromise event with no fallback.

Restricting the Web client to one Account at a time was rejected as strictly worse for no gain: two
Accounts on the same Server already trust the same operator.

## Consequences

The Web client's blast radius is exactly one Server. Its widest scope is that Server, so All Accounts,
cross-Server Collections, and cross-Server copy are installed-client features and the product says so.

Two technical simplifications follow, and both are load-bearing. The Web client is same-origin with
its Server, so no Server sends cross-origin resource sharing headers and no deployment configures an
origin allowlist (`ARCH-HOST-002`). And `HOST-009`'s Content Security Policy can pin `connect-src` to
`'self'`, which would otherwise have had to accept arbitrary origins.

Users who genuinely want several Servers in one place install the Desktop client. That is a real
product cost on the Web surface, stated rather than hidden.
