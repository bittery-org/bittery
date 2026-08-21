# Travel mode

Type: grilling
Status: ready-for-human
Blocked by: 11, 18

## Question

`TRAVEL-001` requires secure eviction of disallowed Vault ciphertext, indexes and keys after policy receipt, while making no impossible promise about Devices that stay offline or about storage forensics and backups.

Decide:

- What eviction means concretely on each storage backend, including whether a browser can actually erase anything.
- What the index eviction hands over from [search and autofill](20-search-and-autofill-index.md).
- What the user is told about the limits, in plain words, before they rely on it.
- Whether the policy is server-held as today, or device-local.
- What an inspector at a border can observe about the fact that Travel mode is on.
- Re-enabling: what has to resync, and how long it takes.

Produces: `TRAVEL-001` refinement and an honesty clause.

### Inherited from Search and autofill index

Policy receipt atomically invalidates volatile index views and removes old Search and Suggestion
snapshot records and wrapped local keys before a disallowed Vault contributes another result. The
allowed remainder rebuilds under fresh keys; no pre-policy key is reused. This ticket still owns the
cross-backend deletion ceremony, policy location, disclosure, observability, and re-enable flow, not
the settled index cryptography.
