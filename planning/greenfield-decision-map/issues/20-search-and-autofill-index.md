# Search and autofill index

Type: grilling
Status: ready-for-human
Blocked by: 04, 15

## Question

`ITEM-003` encrypts titles, URLs, tags and Favorite; `OFFLINE-001` requires browse, search and autofill offline. Domain-matched autofill must therefore evaluate every Item's URL set on every page load against a store that cannot index ciphertext. The only acknowledgement is one word inside `TRAVEL-001`, which presumes an index no requirement creates. See [corpus review, Significant #2](../research/corpus-review.md).

Decide:

- Memory-only index rebuilt at unlock, or persisted and encrypted.
- If persisted: what an attacker with the file learns, and which requirement bounds it. Term frequencies, Item counts, and domain sets all leak by default.
- Domain matching rules for autofill, including subdomain and public-suffix handling.
- Index scope under `ACCOUNT-003`, and how it is evicted for Travel mode.
- The unlock-to-list cost on a large Vault, which is the practical ceiling on the memory-only option.
- Whether search covers Secure Note bodies and custom fields.

Produces: an index specification, a `PRIVACY-*` bound, and an input to performance budgets.
