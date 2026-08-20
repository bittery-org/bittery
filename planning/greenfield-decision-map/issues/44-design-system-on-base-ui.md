# Design system on Base UI

Type: prototype
Status: ready-for-human
Blocked by: 40

## Question

Settled: a modernized design system, with the current Bittery UI as reference for information architecture and flows rather than for styling. Primitives move to Base UI.

Research corrections to carry in: the package is **`@base-ui/react`** (the corpus name `@base-ui-components/react` is deprecated), it is stable at 1.7.0, and shadcn/ui has defaulted to Base UI since 2026-07-03. Base UI ships 37 components but **no date picker, no data table, and no virtualized list**, so budget TanStack Table, TanStack Virtual, and a third-party picker from day one. See [library maturity](../research/library-maturity.md).

Build enough of a prototype to react to: token set, a few core screens, and the vault list at realistic size.

Decide:

- Design tokens: colour, type, spacing, radius, elevation, and dark mode.
- The component inventory, and which gaps need third-party or hand-built components.
- Navigation and layout patterns across Web, Desktop, and Extension, which have very different frames.
- What carries over from today's Bittery and what is deliberately dropped.
- How the vault list performs at realistic size, feeding [performance budgets](50-performance-budgets.md).
