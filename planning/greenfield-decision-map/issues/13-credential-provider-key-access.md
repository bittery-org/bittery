# Credential-provider process key access

Type: grilling
Status: ready-for-human
Blocked by: 12

## Question

Mobile ships later, but this decision constrains the engine now, and it is exactly where the previous implementation's security model broke. The frozen Android path calls `crypto.exportKey(masterUnlockKey)` and hands base64 across the seam **today**, in both directions, and inside Kotlin the KeyRef discipline is dropped entirely. Two frozen documents disagree about whether the provider even runs in its own process. See [current-state verification](../research/current-state-verification.md) and [corpus review, Significant #4](../research/corpus-review.md).

`ARCH-ENGINE-002` says these processes "use constrained runtimes and an explicit shared-store locking/protocol design", which names the ciphertext problem and skips the key problem.

Decide:

- How an OS-launched credential-provider process obtains decryption capability: its own OS-gated wrapper with a narrower key, IPC from the main runtime, or something else.
- Whether that key is narrower than the master unlock key: autofill-scoped, per-Vault, or read-only.
- The concurrency and locking protocol over a shared replica when two processes are live.
- The reduced guarantee this creates, written as a requirement rather than left implicit.
- Whether the same shape serves iOS AutoFill and Android Credential Manager, or whether they diverge.

Produces: `ARCH-ENGINE-002` refinement, a key-scope decision, and an ADR.
