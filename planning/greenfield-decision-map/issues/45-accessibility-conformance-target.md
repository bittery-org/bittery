# Accessibility conformance target

Type: grilling
Status: ready-for-human
Blocked by: 44

## Question

The corpus never names a conformance level. Base UI states WAI-ARIA Authoring Practices adherence at the library level but publishes **no per-component keyboard interaction tables**, so per-component contracts are the product's job.

Decide:

- The conformance target: WCAG 2.2 level A, AA, or AA plus named AAA criteria, and whether it is release-blocking.
- Per-component keyboard contracts, and the tests that hold them.
- Screen-reader support matrix: which readers on which platforms are actually tested.
- What autofill and unlock flows require, since those are the highest-stakes interactions.
- Whether the extension popup and the desktop frame carry the same target as Web.
- Reduced motion, contrast, and zoom behaviour.

Produces: an `A11Y-*` requirement family and CI checks.
