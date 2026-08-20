# Repository foundation and architecture enforcement

Type: grilling
Status: ready-for-human
Blocked by: 38

## Question

Settled: the product is **MIT licensed**, replacing the frozen tree's AGPL-3.0 and GPL-3.0 files. The build order is Rust core first, then server and sync, then the clients around them.

Decide:

- Monorepo layout and the crate and package boundaries that follow from the architecture.
- Toolchain: Rust edition and MSRV, Node and package manager, and how versions are pinned.
- CI: what runs, on what, and what blocks a merge.
- Architecture enforcement, which `target/architecture.md` demands: forbidden dependency directions, restated generated types, policy in adapters, external integrations enabled by default. The frozen `scripts/check-architecture.mjs` is worth mining.
- Dependency governance: pinning policy, upgrade cadence, and who reviews a new dependency in a security product.
- Where the MIT licence file goes and what headers, if any, source files carry.

Produces: the repository-foundation specification that `CLAUDE.md` currently defers, and the build and test commands the checks section is waiting on.
## Comments

### Superseded in part by ticket 04's reopened answer

The Web bundle hash remains a reproducible-release and deployment-conformance check. It is not a
substitution-detection mechanism and no check may describe it as proof of bytes delivered to Users.

### Inherited from ticket 05, client delivery trust and transport

Three new CI obligations arrive from this ticket, alongside the `PRIVACY-006` plaintext schema check.

`PRIVACY-016` requires a reproducible Web client build whose content hash is published with each
release, and the Server must serve that byte-exact bundle. The check has to compare what a Server
would serve against the published hash.

`HOST-009` and `ARCH-HOST-001` fix Content Security Policy strings for the Web client, the Desktop
webview, and Extension pages. A check should assert the served header and the extension manifest match
the requirement text, since a silently loosened policy is invisible otherwise.
