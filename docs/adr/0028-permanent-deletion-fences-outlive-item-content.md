# Permanent-deletion fences outlive Item content

Permanent deletion removes content-bearing Item revisions, history and Attachments but retains the
exact signed Tombstone revision as a compact Deletion Fence until its Vault is deleted. This accepts small unbounded
identifier-and-signature state so a very old Device receives an unambiguous permanent rejection and
cannot recreate the Item; finite Tombstones or probabilistic filters would make correctness depend on
route conventions, identifier luck, or false positives.
