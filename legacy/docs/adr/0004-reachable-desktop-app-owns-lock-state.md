# A reachable desktop app owns lock state; the extension never unlocks behind it

The native-messaging protocol is one-directional for lock state: the desktop app pushes
`lock` / `unlock` events and the extension follows, but the extension has no way to tell the
desktop that it unlocked. An extension-side unlock while the desktop sits locked therefore
leaves the two halves permanently diverged. The rule is absolute rather than best-effort —
while a locked desktop is reachable the extension refuses to unlock locally and asks the
desktop to raise its own unlock screen (`background/desktop-unlock.ts`); the escape hatch
when the desktop is wedged is to quit it, after which the extension unlocks standalone.

It is enforced in two structurally different places on purpose. `requireDesktopUnlock()` is
an imperative pre-check at the entry points that would derive a MUK (`auth-handlers.ts`,
`native-messaging.ts`), so the refusal is visible where the user asked for it; the
`vault-session` reducer independently refuses with `desktop_owns_unlock` in `unlockLocally`,
and refuses popup-initiated locks with `desktop_owns_lock`, so anything that slipped past
the pre-check still cannot reach an unlocked state. Removing either layer looks like
deduplication and is not.
