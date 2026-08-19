# `background/session-manager.ts` stays as a facade over `vault-session/`

When lock state moved into the `vault-session` machine, the old module path was kept rather
than rewritten away: it holds no state and every export is a one-liner over `vaultSession`.
Roughly a dozen background modules import it and six test suites mock the path, so deleting
it would turn a contained refactor into a wide, mechanical, merge-conflict-prone edit across
handlers and their mocks for no behavioural gain. It looks like dead indirection and is
retained on purpose; if it is ever removed, the call sites and the `mock.module` targets have
to move in the same commit.
