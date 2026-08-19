# Reading the vault session re-evaluates it, and a read may lock the vault

`vaultSession.getSnapshot()` in `background/vault-session/machine.ts` is not a plain getter:
it re-reads the cached desktop status and the elapsed timeout, and dispatches
`DESKTOP_OBSERVED` / `TIMEOUT_ELAPSED` synchronously before projecting. The alternative —
trusting the state cell and letting alarms keep it fresh — fails open in exactly the cases
that matter: an MV3 service worker whose alarm never fired, or a desktop app that locked
behind our back, would keep serving autofill, passkey and credential requests from a vault
that should be locked. `isUnlocked()` is on that hot path and is synchronous by contract,
which is why the re-evaluation is synchronous too, with an `evaluating` guard against
re-entry.

The same fail-closed bias sets the ordering rule in `machine.ts`: state is committed before
any effect runs, so `dispatchNow` returns an already-locked snapshot while `clear_keys` is
still in flight, and no effect may reject.
