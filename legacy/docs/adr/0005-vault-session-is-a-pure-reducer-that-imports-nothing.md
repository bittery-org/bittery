# The extension vault session is a pure reducer that imports nothing

Lock state in the extension is decided by `background/vault-session/transitions.ts`, a pure
`(state, event) -> { next, effects }` function, and carried out by
`vault-session/machine.ts`, which is the only place that touches chrome, storage, the
desktop client or the clock. Every event carries its own `at`, so the whole transition table
— desktop ownership, auto-lock, revocation, fail-closed ordering — is testable without a
single mock, which is the point of the split.

The purity is literal: `transitions.ts` has no runtime imports at all, which is why it
re-declares the auto-lock default as `DEFAULT_SETTINGS_TIMEOUT_MS = 10 * 60 * 1000` instead
of importing `DEFAULT_AUTO_LOCK_TIMEOUT_MS` from `@bittery/storage`. The duplicated
literal is the price of the constraint and is marked as such in the code; "fixing" it
reintroduces the import edge the module exists to avoid.
