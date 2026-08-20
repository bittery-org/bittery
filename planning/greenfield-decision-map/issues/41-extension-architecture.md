# Extension architecture for Chromium and Firefox

Type: grilling
Status: ready-for-human
Blocked by: 03, 39, 40

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
