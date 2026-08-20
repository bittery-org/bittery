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
