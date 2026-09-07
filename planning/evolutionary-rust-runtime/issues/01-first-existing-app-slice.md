# First existing-application slice

Type: grilling
Status: resolved
Blocked by:

## Question

Which existing host and end-to-end path should first prove the shared Runtime?

## Answer

The first slice uses Web and begins with Sign-in inside the shared Rust Worker. Rust owns the existing
SRP ceremony, KDF-profile validation, Server-proof verification, Session creation and renewal,
Account persistence, Bootstrap, restart followed by online unlock and offline read, durable offline
acceptance of one new Login Item, retry after reconnect, exactly one Server effect, and authoritative
reconciliation. The host
collects credentials and provides platform adapters; current cryptographic algorithms and formats do
not change.
