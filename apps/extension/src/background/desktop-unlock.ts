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
 * Every unlock entry point therefore hands off to the desktop first, and only
 * falls back to unlocking locally when the handoff could not be delivered. This
 * mirrors the rule already enforced on the lock side by `session-manager.lock()`.
 */

import { desktopClient } from "./desktop-client";
import { isDesktopLockedNow } from "./desktop-status";

/** Status returned to the UI when the desktop was asked to unlock instead. */
export const PENDING_DESKTOP_UNLOCK = "pending-desktop-unlock" as const;

export interface DesktopUnlockHandoff {
	/**
	 * `true` when the desktop app took over the unlock. The caller must not
	 * unlock locally, and should wait for the pushed `DESKTOP_UNLOCKED` event.
	 */
	handedOff: boolean;
}

/**
 * Hand an unlock request to the desktop app if one is connected and locked.
 *
 * Returns `{ handedOff: false }` when there is no locked desktop to hand off to,
 * or when the desktop failed to accept the request (app wedged, IPC socket gone)
 * — in that case the caller should unlock locally rather than dead-ending the
 * user.
 */
export async function handOffUnlockToDesktop(): Promise<DesktopUnlockHandoff> {
	if (!(await isDesktopLockedNow())) {
		return { handedOff: false };
	}

	const triggered = await desktopClient.triggerDesktopUnlock();
	if (!triggered) {
		console.warn(
			"[desktop-unlock] Desktop is locked but did not accept the unlock request; falling back to local unlock",
		);
	}

	return { handedOff: triggered };
}
