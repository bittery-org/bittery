# Mobile architecture seams

Type: grilling
Status: ready-for-human
Blocked by: 13, 39

## Question

Architecture altitude only. iOS and Android ship after the first release, and this ticket exists so the engine seam does not have to be rewritten when they do. Note that iOS is an empty scaffold today (one 4-line `main.mm`, zero Swift files) and Android carries a full second data model: a Room database at version 8 with `fallbackToDestructiveMigration(true)` and a biometric-gated MUK escrow.

Decide:

- What the engine must expose for a SwiftUI and a Compose host, and what it must never expose.
- The native replica seam, and whether the credential-provider process shares it, taking its key model from [credential-provider key access](13-credential-provider-key-access.md).
- Background scheduling: what sync work each OS permits, and what the engine must tolerate being killed mid-operation.
- Whether a second data model is ever acceptable, or whether the engine is the single source.
- What the binding must support that the desktop and web hosts do not need.

Explicitly out: iOS and Android UI, unlock UX, and platform-specific product behaviour. Those belong to a later map.
