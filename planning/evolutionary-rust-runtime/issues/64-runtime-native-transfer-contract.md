# Runtime-owned Desktop–Extension transfer

Type: grilling
Status: resolved
Blocked by: 60, 61, 62

## Question

How does the connected Extension preserve its existing local durable work while following Desktop
lock authority, without broker/popup key ownership?

## Accepted contract

Preserve existing Extension-local write placement and existing cryptographic transfer formats.
Implement export/import once in shared Core with explicit source/destination Account identity,
Account incarnation, connection/owner incarnation and lock-epoch checks. Broker/native binaries
transport the closed capability; only the destination Runtime installs live keys. Desktop lock,
disconnect, revocation and removal retire the capability and plaintext access. Retired generations
cannot be restored by cached projections or late transfer responses. Broker recycle preserves an
existing offscreen owner; replacement owner starts locked and requests fresh Desktop authority.

Preserve both ADR 0004 checks: user-facing entry refusal redirects unlock to Desktop, and Core
independently refuses unauthorized local unlock. They protect different boundaries.

Do not move already accepted Extension Operations into Desktop, replay UI commands, retain a second
local queue, or duplicate key/Session/travel policy in the broker. Native biometric release remains
local and uses no new durable login secret under ADR 0015.

## Comments

2026-09-08: maintainer accepted preserving Extension-local Operations with shared Core transfer.
This resolves write placement and authorization ownership; delivery must specify closed binding
values and test the existing formats and all retirement races before cutover.
