# Administration, registration, and retention

Type: grilling
Status: ready-for-human
Blocked by: 04, 22

## Question

`ADMIN-001` and `ADMIN-002` define an administrator who governs without decrypting. Two changes are already settled and must be carried in: **quotas are removed from the product entirely**, and the self-hosted mode switch is gone. Note that the frozen product has no operator-level admin at all, only a team admin console, so this is largely new construction.

Decide:

- The administrator capability list, rewritten without quotas.
- Registration modes (open, invitation-only, closed) and how each is configured.
- Suspension and deletion of encrypted server data: what it does to a user's clients.
- Retention controls that survive the quota removal: audit, revisions, Trash, sync events.
- What an administrator can see, checked against the closed plaintext list.
- Whether there is a first-run bootstrap for the first administrator, and how it is secured.

Produces: `ADMIN-*` rewrites and a disposition row correction.

### Inherited from ticket 07, key derivation profiles

`AUTH-021` states that a Server cannot enforce master password policy, because **no Server ever sees a
master password**. The 15-code-point minimum, bundled common-and-compromised-password blocklist,
advisory strength estimate, and generated-passphrase offer are all client-side. An administrator
therefore has no lever over master password strength, and this ticket must state that plainly rather
than let an operator assume a policy setting exists.

`AUTH-010` makes the profile byte visible in each stored OPAQUE registration under `PRIVACY-007`, so an
administrator may inspect that byte while diagnosing sign-in. `AUTH-019` makes it non-authoritative:
the Server cannot supply or alter the client-carried pin, choose parameters, or make the client fall
back. The administrator must still compare the observed byte with the User's Device state or Emergency
Kit rather than treating Server state as the answer.
