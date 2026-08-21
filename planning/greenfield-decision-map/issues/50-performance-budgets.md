# Performance budgets

Type: grilling
Status: ready-for-human
Blocked by: 20, 38

## Question

The architecture requires approved user-visible budgets and forbids technology-specific speed claims, and names six: unlock-to-list, search, autofill, local mutation acknowledgement, cold-start memory, and background energy.

Decide:

- The number for each budget, and the percentile it is measured at.
- The representative Vault sizes and device classes the budgets are measured on.
- How each is measured in CI, so a regression fails rather than being noticed later.
- The unlock-to-list budget specifically, since it is the ceiling on the memory-only search index option.
- What happens when a budget is missed: block the release, or record an exception.
- Whether the extension and the desktop carry the same numbers as Web.

Produces: a `PERF-*` requirement family with measurable acceptance.

### Inherited from Search and autofill index

Measure the warm path from Account unlock through decrypting and loading a valid opaquely encrypted
Search Snapshot. Measure the cold path separately: browse appears progressively, domain matching has
priority, and search/autofill remains explicitly incomplete until ready. This ticket owns the reference
Vault's Item count, searchable text volume and URL count, device classes, percentiles, numeric budgets,
and release response; it must not collapse warm and rebuild latency into one misleading number.
