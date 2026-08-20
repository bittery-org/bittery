# Desktop architecture and the extension IPC

Type: grilling
Status: ready-for-human
Blocked by: 39, 41

## Question

First-release scope, settled: Desktop is a **full vault-browsing client plus Sentinel, Share links, and import/export**. Account lifecycle, teams, invitations, and admin stay on Web. Today's desktop is a vault-browsing shell with 4 unit tests and no e2e coverage, so most of this is new.

The frozen desktop-to-extension IPC is worth mining and worth distrusting: 1291 lines of hand-rolled peer identity with `SO_PEERCRED` plus executable-path verification, 0700 socket dirs, an explicit Windows SDDL because the NPFS default DACL grants Everyone, an asymmetric policy (app `Required`, host `BestEffort`), and a known dead extension-origin allowlist. The extension's biometric-transfer "signature" is `btoa(challenge:boundTo)`, a binding tag rather than a signature. See [current-state verification](../research/current-state-verification.md).

Decide:

- Tauri v2 boundaries: what the renderer may never touch.
- Native runtime ownership and where the replica and keys live.
- The desktop-to-extension protocol: transport, peer authentication, lock authority, and what crosses it.
- Whether biometric material transfer exists at all, and if so what actually signs it.
- CSP for the webview, which is currently `null`.
- Native messaging installation per OS, and how the extension identity is bound.
## Comments

### Inherited from ticket 05, client delivery trust and transport

`ARCH-HOST-001` applies the `HOST-009` Content Security Policy to the Desktop webview. The frozen
tree's `csp: null` is now a defect, so this ticket decides how the policy is expressed under Tauri,
including whatever the asset protocol needs, without loosening `script-src` past
`'self' 'wasm-unsafe-eval'`.

`ACCOUNT-001` makes Desktop the surface that carries multi-Server, All Accounts, and cross-Server
Collections, since the Web client cannot. That raises this ticket's weight for ticket 36.

### Inherited from ticket 07, key derivation profiles

`AUTH-016` fixes key derivation at Argon2id with **64 MiB of memory**, and `AUTH-017` makes the profile
registry append-only, so this number never falls. Any surface that performs a full sign-in must be able
to allocate 64 MiB plus overhead for the duration of that derivation. If this surface cannot, it must
not perform a full sign-in at all and must enrol by some other route, which is a decision this ticket
owns rather than one it inherits.
