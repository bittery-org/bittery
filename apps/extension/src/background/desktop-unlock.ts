/**
 * Desktop unlock authority.
 *
 * While the desktop app is connected it owns the lock state: it pushes `lock` /
 * `unlock` events and the extension follows them (see `desktop-sync.ts`). The
 * reverse direction does not exist — the protocol has no way for the extension
 * to tell the desktop it unlocked. So any extension-side unlock that derives its
 * own MUK while the desktop sits locked leaves the two halves diverged: the
 * extension unlocked, the desktop still locked.
 *
 * The rule is therefore absolute rather than best-effort: while a locked desktop
 * is reachable, the extension does not unlock at all, it asks the desktop to.
 * `session-manager.isUnlocked()` enforces the same invariant on every read, so a
 * local unlock that slipped through would be undone on the next check anyway —
 * refusing up front just makes that visible instead of baffling.
 *
 * The escape hatch when the desktop app is wedged is to quit it. Once it stops
 * answering, the extension is no longer shadowing anything and unlocks
 * standalone as usual.
 */

import { desktopClient } from "./desktop-client";
import { isDesktopLockedNow } from "./desktop-status";

export interface DesktopUnlockOutcome {
	/**
	 * `true` when a locked desktop app is present. The caller must not unlock
	 * locally, whether or not the request below was accepted.
	 */
	required: boolean;
	/**
	 * `true` when the desktop accepted the request and is showing its unlock
	 * screen. `false` means it is reachable but wedged — the caller should say so
	 * rather than silently unlocking only the extension.
	 */
	triggered: boolean;
}

/**
 * Ask the desktop app to raise its own unlock screen, if a locked one is
 * connected.
 */
export async function requireDesktopUnlock(): Promise<DesktopUnlockOutcome> {
	if (!(await isDesktopLockedNow())) {
		return { required: false, triggered: false };
	}

	const triggered = await desktopClient.triggerDesktopUnlock();
	if (!triggered) {
		console.warn(
			"[desktop-unlock] Desktop is locked but did not accept the unlock request",
		);
	}

	return { required: true, triggered };
}
