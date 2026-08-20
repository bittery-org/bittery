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

Local Network Access was unresolved when this comment was written. Ticket 52 has now settled the
facts; see the comment below.

### Inherited from ticket 07, key derivation profiles

`AUTH-016` fixes key derivation at Argon2id with **64 MiB of memory**, and `AUTH-017` makes the profile
registry append-only, so this number never falls. Any surface that performs a full sign-in must be able
to allocate 64 MiB plus overhead for the duration of that derivation. If this surface cannot, it must
not perform a full sign-in at all and must enrol by some other route, which is a decision this ticket
owns rather than one it inherits.

### Inherited from ticket 52, Local Network Access facts

[Ticket 52](52-extension-local-network-access-facts.md) resolved. Findings in
[research/extension-local-network-access.md](../research/extension-local-network-access.md).

A background context reaches a LAN Server **without a prompt on both engines today**, because
Chromium maps `chrome-extension://` to the loopback address space and Firefox leaves a
`moz-extension://` initiator at `Unknown`. Neither is a contract. Chrome says it has no plans "to
apply LNA restrictions to extensions" *currently*, and the mechanism already failed in Chrome 138 and
139. Firefox's exemption is a specification divergence with no test covering it, and Bugzilla shows an
engineer intending to write the real check.

Two decisions land in this ticket as a result:

- **Content scripts are gated.** They inherit the host page's client security state on both engines,
  so a content script on a public page is blocked from a LAN Server exactly as that page would be.
  Undocumented by either vendor. This is an argument for the background host owning **all** network
  I/O, with content scripts as message-passing clients that never open a socket. Read alongside
  ticket 03: `storage.session` is already unreachable from a Firefox content script, so both facts
  point the same way.
- **Withdrawal behaviour.** If either engine removes its exemption, every LAN and overlay deployment
  breaks with a bare `TypeError` that is indistinguishable from an unreachable Server. The only
  discriminator is `navigator.permissions.query({name: "local-network"})`, which works on both
  engines. Whether the Extension probes that to give an honest error is this ticket's call.

`host_permissions` is not an exemption and no local-network extension permission exists on either
engine, so there is nothing to declare in the manifest. `100.64.0.0/10` is classified **local**, not
public, so the overlay route changes nothing about the gate; it earns its place by supplying the
secure context `HOST-007` demands.
