# Extension architecture for Chromium and Firefox

Type: grilling
Status: ready-for-human
Blocked by: 03, 39, 40, 52

## Question

First-release scope, settled: the Extension is **autofill and in-browser vault use**. Reading Items, TOTP, passkeys, save prompts, and quick unlock. **No import/export and no Sentinel.** Both Chromium and Firefox ship in the first cut, and no Firefox extension exists today.

Decide:

- The background host as sole runtime owner, and popup and content scripts as typed clients.
- MV3 lifecycle: what survives worker termination, and what the user experiences when it does not.
- The autofill model: field detection, domain matching, and the save-prompt flow.
- Passkey mediation: creation and assertion, and what it needs from the Item model.
- One codebase or a build-time split for Firefox, informed by the research ticket.
- Extension storage as a profile trust boundary rather than a keychain, per `ARCH-STORE-003`.
- What the extension does when the desktop app is present, handing over to [desktop architecture](42-desktop-architecture-and-ipc.md).
## Comments

### Inherited from ticket 05, client delivery trust and transport

`ARCH-HOST-001` has Extension pages declare `script-src 'self' 'wasm-unsafe-eval'` under
`content_security_policy.extension_pages`. Verified this session: Chromium and Firefox both cap that
directive at `'none'`, `'self'` and `'wasm-unsafe-eval'`, and impose
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` as the floor, so there is nothing to choose
beyond declaring it. Without `'wasm-unsafe-eval'` the engine does not instantiate.

Unresolved and relevant here: Chrome 142 and later, and Firefox from 149 (strict) rolling out from
151, gate requests from a public origin to RFC 1918 addresses, loopback, and `.local` names behind a
user permission prompt; Firefox 154 extended it to WebSockets on 2026-08-17. Whether an extension
background context is subject to that gate, and whether `100.64.0.0/10` (overlay networks) counts as
private, are both unsettled. This decides whether an Extension can reach a LAN Server without a
prompt. Worth a research ticket before this session runs.
