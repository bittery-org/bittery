# Maturity of four technology bets

Produced by a subagent during the Wayfinder charting session. Every item retrieved **2026-08-20**.
Status: evidence. Facts only; the decisions they bear on live in their tickets.

## Base UI

**Bottom line:** stable and shipped. v1.0.0 landed 2025-12-11 and it is now at 1.7.0, and shadcn/ui made it the *default* primitive in July 2026. The catches are a package rename and three missing components.

- **The package name in the corpus is deprecated.** `@base-ui-components/react` stops at `1.0.0-rc.0` (2025-12-04) and carries the deprecation string "Package was renamed to @base-ui/react". The live package is **`@base-ui/react`**. Sources: `https://registry.npmjs.org/@base-ui-components/react`, `https://registry.npmjs.org/@base-ui/react`
- **Latest version 1.7.0**, published 2026-08-04. Stable 1.0.0 on 2025-12-11. Roughly monthly minors since. Source: `https://registry.npmjs.org/@base-ui/react`
- **Repo very active:** last commit 2026-08-20, 10.6k stars, 420 open issues. Source: `https://api.github.com/repos/mui/base-ui`
- **37 components ship today:** Accordion, Alert Dialog, Autocomplete, Avatar, Button, Checkbox, Checkbox Group, Collapsible, Combobox, Context Menu, Dialog, Drawer, Field, Fieldset, Form, Input, Menu, Menubar, Meter, Navigation Menu, Number Field, OTP Field, Popover, Preview Card, Progress, Radio, Scroll Area, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, Toggle Group, Toolbar, Tooltip. Source: `https://base-ui.com/llms.txt`
- **Still missing: date picker, data table, virtualized list.** Combobox and Toast now ship. Date picker is open work across three issues: mui/base-ui#1709, #3332, #2724.
- **Forward signal on pickers:** 1.7.0 already declares `date-fns ^4.0.0` and `@date-fns/tz ^1.2.0` as peer dependencies. Treat as a hint, not a commitment; no shipped date component is verifiable from the docs.
- **Accessibility: good at library level, thin at page level.** The docs state components "adhere to the WAI-ARIA Authoring Practices" and handle ARIA/role attributes, pointer interaction, keyboard navigation and focus management. But there is **no per-component keyboard interaction table**: the Select page documents accessible-name requirements and data attributes with no arrow/Enter/Escape reference. Sources: `https://base-ui.com/react/overview/accessibility`, `https://base-ui.com/react/components/select`
- **shadcn/ui support is official and now default.** Since 2026-07-03, `npx shadcn init` wires Base UI; pass `shadcn init -b radix` to keep Radix. Radix is explicitly not deprecated. Component documentation coverage for Base UI was completed January 2026. The docs enumerate no exceptions, so "which components lack a Base UI variant" is **unverified**. Sources: `https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default`, `https://ui.shadcn.com/docs/changelog/2026-01-base-ui`
- **Migration from a Radix shadcn codebase: low-to-moderate, agent-driven.** No codemod. shadcn ships a migration skill (`pnpm dlx skills add shadcn/ui`) that migrates one component at a time with per-component reports and commits. Their own reported test: 60+ components, 36 originally Radix, in roughly 25 minutes.

## Effect

**Bottom line:** v4 is **not** stable. It is in release candidate as of 2026-08-12, stable targeted Q3/Q4 2026. Latest stable on npm is still **3.22.1**.

- **npm dist-tags:** `latest: 3.22.1` (2026-07-30), `beta: 4.0.0-beta.107` (2026-08-10), `rc: 4.0.0-rc.111` (2026-08-20). `npm i effect` still gets v3. Source: `https://registry.npmjs.org/effect`
- **RC cadence is fast:** rc.108 (08-12), rc.109 (08-14), rc.110 (08-17), rc.111 (08-20). The `rc` tag moved four times in eight days.
- **v3 still actively maintained in parallel:** 3.21.5, 3.22.0 (2026-07-13) and 3.22.1 (2026-07-30) all shipped during the RC period.
- **Stated timeline for stable: "Q3/Q4 2026."** The RC announcement says the sweeping changes are behind them and no broad breaking changes are planned, with interfaces "presumed final" but a reserved right to narrowly-scoped breaks. Remaining work: production validation, regression and perf fixes, a documentation rewrite, tooling. Source: `https://www.effect.website/blog/releases/effect/40-rc`
- **Migration path: a written guide, no codemod.** `MIGRATION.md` covers 14 core migration guides plus a separate Schema section. The team's stated intent is that the guide give a coding agent enough context for a near-automated migration. Source: `https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md`
- **How breaking: structurally severe, conceptually mild.** The core model survives. The ecosystem collapses to one version number, with `@effect/platform`, `@effect/rpc`, `@effect/cluster` and others merged into `effect`; `Context.Tag` becomes `Context.Service`; `FiberRef` is replaced by `Context.Reference`; forking, fiber, runtime and scope are restructured; error-handling methods are renamed.
- **Schema is the expensive part.** v4 schemas carry 14 type parameters (v3 had 6-8), the single `R` dependency parameter splits into `RD` (decode) and `RE` (encode), implicit JSON serialization is gone in favour of explicit codecs, and transformations become standalone composable objects. Also removed: `Effect.Do`/`bind`/`let`/`bindTo`, `Effect.once`/`iterate`/`reduce`/`if`; Array methods return `| undefined` instead of `Option`.
- **Payoff cited:** rewritten fiber runtime, a minimal Effect program bundling to roughly 6.3 KB minified and gzipped, native Deno support.
- **Unverified:** whether v3 and v4 can be installed side by side.

## OPAQUE in Rust

**Bottom line:** RFC 9807 is published but **Informational (IRTF/CFRG), not Standards Track**. `opaque-ke` 4.0.x is synced to it and verifies against the RFC's own Appendix C vectors. The soft spots are release cadence and an audit that predates the RFC alignment.

- **RFC 9807 confirmed.** "The OPAQUE Augmented Password-Authenticated Key Exchange (aPAKE) Protocol", July 2025, 73 pages. Authors Bourdrez, Krawczyk (AWS), Lewi (Meta), Wood (Cloudflare). Sources: `https://datatracker.ietf.org/api/v1/doc/document/rfc9807/?format=json`, `https://www.rfc-editor.org/rfc/rfc9807.txt`
- **Status: Informational, IRTF stream, CFRG.** `std_level: inf`, `stream: irtf`. The RFC text is blunt: "This document is not an Internet Standards Track specification; it is published for informational purposes... These results might not be suitable for deployment." CFRG consensus, not IETF consensus.
- **`opaque-ke` versions:** latest stable **4.0.1** (2025-11-03). Newest overall is prerelease **4.1.0-pre.2** (2026-03-27). Earlier: 4.0.0 (2025-10-24), 3.0.0 (2024-10-10). 564,764 total downloads. Source: `https://crates.io/api/v1/crates/opaque-ke`
- **It claims RFC 9807, not a draft.** The 4.0.0 changelog reads "Synced implementation with RFC 9807 (no core protocol changes)."
- **RFC 9807 test vectors exist and the crate verifies against them.** Appendix C of the RFC; embedded verbatim at `src/tests/rfc9807_vectors.rs` (810 lines), covering real and fake vectors across ciphersuites including OPAQUE-3DH with ristretto255-SHA512.
- **Maintenance: alive but slow.** `facebook/opaque-ke`: last commit to main 2026-03-27, last push 2026-06-23, 415 stars, 8 open issues. A five-month commit gap; small and finished-feeling rather than abandoned.
- **The audit is old.** NCC Group, June 2021, sponsored by WhatsApp, against 0.5.0, addressed in 1.2.0. There is **no** audit covering the 4.x RFC-9807-synced code.
- **MSRV Rust 1.87** on main.
- **No credible alternative Rust implementation.** `opaque-borink` 0.6.1 (2025-01-07, 62 recent downloads) and `opaque-ke-hybrid` 0.1.0 (2026-04-28, 12 recent downloads) are both thin layers over `opaque-ke`. Treat both as hobby-scale.

## UniFFI

**Bottom line:** healthy at 0.32.0 and excellent for iOS/Android, but WASM is **experimental with no first-party generator**. The browser half of the requirement rests on a project whose own docs say it should not be used in production.

- **Latest 0.32.0**, released 2026-06-30. Prior: 0.31.2 (2026-06-17), 0.31.1 (2026-04-13), 0.31.0 (2026-01-14). 10.99M total downloads, 3.55M recent. Source: `https://crates.io/api/v1/crates/uniffi`
- **Maintenance strong.** `mozilla/uniffi-rs` last commit 2026-08-18, 4.9k stars, 285 open issues. Mozilla ships it in Firefox mobile and desktop.
- **First-party language support:** full for Kotlin, Swift, Python; Ruby partial. Everything else is third-party.
- **WASM: opt-in Rust-side accommodation, no bundled generator.** UniFFI does not ship a WASM bindings generator. Rust-side you enable **`wasm-unstable-single-threaded`**, which "opts out of the `Send` and `Sync` checks when building for `wasm32` target architectures", and the docs warn the feature is "likely to change or go away completely." Source: `https://mozilla.github.io/uniffi-rs/latest/wasm/configuration.html`
- **0.31/0.32 did improve WASM ergonomics:** for `wasm32` targets, futures no longer require `Send`, making them compatible with `wasm-bindgen` futures.
- **The standard pairing for one Rust codebase to browser Worker plus iOS plus Android is `uniffi-bindgen-react-native`.** It generates bindings for Hermes via JSI, for WASM via `wasm-bindgen`, and for Node via a compiled `cdylib`, all from one UniFFI interface, with sync and async calls in both directions. Slated to be renamed `uniffi-bindgen-javascript`. Source: `https://jhugman.github.io/uniffi-bindgen-react-native/`
- **It carries an explicit production warning:** "This project is still in early development, and should not yet be used in production." Active (last commit 2026-08-11, 540 stars, 45 open issues) but one maintainer's project outside the Mozilla org.
- **A second option, maturity unverified:** `uniffi-bindgen-js` generates TypeScript from the compiled WASM binary or UDL, targeting browsers, Node, Deno and Bun without wasm-pack or wasm-bindgen. Source: `https://lib.rs/crates/uniffi-bindgen-js`
- **Async limitation 1: no cancellation.** "We don't directly support cancellation in UniFFI even when the underlying platforms do." You must build your own, e.g. a `cancel()` method plus periodic checks inside the Rust future. Source: `https://mozilla.github.io/uniffi-rs/latest/futures.html`
- **Async limitation 2: the foreign side owns the executor.** The target language supplies the event loop. Exported async traits require `Send + Sync` under the proc-macros. Async functions do not yet support mutable byte-buffer borrowing.
- **Callback interfaces are soft deprecated.** "Foreign traits should be preferred." Callback interfaces use `Box<dyn Trait>` rather than `Arc<dyn Trait>`, and "methods of the foreign class must be safe to call from multiple threads at once", a contract Rust cannot enforce in the foreign code. Source: `https://mozilla.github.io/uniffi-rs/latest/types/callback_interfaces.html`
- **Observation streams have no first-class support.** Neither the futures nor the callback page documents streams or observables. The idiomatic workaround is a foreign trait with one method per event, called from Rust, meaning backpressure and buffering are yours to build.

## Risk summary

| Technology | Maturity | Specific risk | Rough mitigation |
| --- | --- | --- | --- |
| Base UI `@base-ui/react` 1.7.0 | Stable since 2025-12-11 | No date picker, data table, or virtualized list, and those are expensive to build well. The npm rename means copied setup guides install a deprecated RC | Pin `@base-ui/react`. Budget for TanStack Table, TanStack Virtual and a third-party date picker from day one. Write per-component keyboard contract tests, since the docs do not specify them |
| shadcn/ui on Base UI | Default since 2026-07-03; Radix still supported | Low. The real risk is churn if you sit on Radix while upstream examples drift | Migrate with the official skill, one component per commit |
| Effect v4 | Release candidate, not stable | Shipping on an RC whose stable date is a soft "Q3/Q4 2026", with narrowly-scoped breaks still reserved and documentation mid-rewrite | Start on 3.22.1 if you need a stable floor; the core model transfers. If starting on v4, pin an exact rc version, not the `rc` tag, which moved four times in eight days |
| Effect v3 to v4 migration | Guide exists, no codemod | Schema is the sharp edge: 6-8 to 14 type parameters, `R` splits into `RD`/`RE`, implicit JSON serialization removed. Do-notation removal and `Option` to `undefined` touch call sites everywhere | Isolate Schema behind a thin local module now so the blast radius is one file. Plan an agent-driven migration with a strong test suite as the oracle |
| RFC 9807 | Published July 2025, Informational / IRTF-CFRG | Not an IETF standard. The RFC itself says results "might not be suitable for deployment" | Cite it accurately as CFRG-consensus Informational. It is still the authoritative OPAQUE spec |
| `opaque-ke` 4.0.1 | Production-grade code, low-velocity maintenance | Effectively single-vendor: no credible alternative. Five-month commit gap. Only audit is NCC Group June 2021 against 0.5.0, four years and three majors before the RFC sync | Pin 4.0.1, not `4.1.0-pre.*`. Be ready to fork; with 8 open issues that is tractable. Run the bundled `rfc9807_vectors.rs` tests in your own CI. Commission a fresh audit of 4.x if the stakes justify it |
| UniFFI 0.32.0 native | Mature, Mozilla-maintained | Low for iOS/Android. Callback interfaces are soft-deprecated; 0.32.0 shipped breaking changes to async constructors | Use foreign traits, not callback interfaces. Pin the minor version; 0.x means minors break |
| UniFFI on WASM | Experimental, feature named `wasm-unstable-single-threaded` | The weakest link in the stack. Browser support depends on `uniffi-bindgen-react-native`, whose docs say not for production, maintained by one person outside Mozilla. The Send/Sync opt-out is documented as likely to go away | Prototype the Worker path **before** committing the architecture. Keep a fallback: a hand-written `wasm-bindgen` shim for the browser while UniFFI serves iOS/Android, at the cost of one duplicated interface |
| UniFFI async and streams | Partial | No cancellation at all. No stream primitive, so backpressure and buffering are yours | Design the Rust API so long operations are chunked and cancellable by contract from the start. Model event streams as a foreign trait with one method per event, buffering in Rust where it is testable |

**Two things unverified from primary sources:** whether any shadcn/ui components lack a Base UI variant, and whether Effect v3 and v4 can be installed side by side.
