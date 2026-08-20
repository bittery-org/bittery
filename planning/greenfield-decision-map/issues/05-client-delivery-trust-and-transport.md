# Client delivery trust and transport requirements

Type: grilling
Status: ready-for-human
Blocked by: 04

## Question

`HOST-003` has the Server ship the Web client, so for that client `ADMIN-001`'s "cannot decrypt" is false by construction: the operator ships the code that touches the master password. `ACCOUNT-001` widens it, since that page may hold keys for other Servers. No requirement in the corpus mandates TLS or a secure context, and `HOST-001` makes LAN-only `http://` deployments first-class, which withholds `crypto.subtle`, OPFS, and WebAuthn. See [corpus review, Critical #2](../research/corpus-review.md) and [browser storage durability facts](01-browser-storage-durability-facts.md).

Decide:

- Whether an authenticated transport is a `MUST` precondition for the Web client, and what an operator on a LAN is told to do instead of plain `http://`.
- Whether the Web client's weaker guarantee is stated in requirements and surfaced in the UI, in the same honest register as `TRAVEL-001` and `AUTH-008`.
- Whether a Web client served by Server A may hold Accounts from Server B, or whether multi-Server is restricted to installed clients.
- Whether subresource integrity, a pinned build hash, or any code-transparency mechanism is in scope, or explicitly ruled out.
- CSP and HSTS as requirements. The frozen server sets neither, and the desktop webview sets `csp: null`.

Produces: `HOST-*` and `PRIVACY-*` requirement changes, and a decision on `ACCOUNT-001`'s scope.
