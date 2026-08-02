/**
 * The only file in `vault-session/` that knows `DesktopStatus` exists.
 *
 * It projects the desktop app's wire status onto the four fields the reducer
 * reasons about. A `null` status is passed through as `null` rather than being
 * flattened into `connected: false`, because "unreachable" is a first-class
 * transition (it is what the old poll-edge guard used to swallow).
 */

import type { DesktopStatus } from "../../desktop-protocol";
import { desktopSync } from "../../desktop-sync";
import type { DesktopPort } from "../ports";
import type { DesktopSnapshot } from "../types";

/**
 * `connected` is reachability, never the payload's `available` self-report.
 * The native host answers `{available:false, locked:true}` whenever it cannot
 * reach the desktop app, so reading `available` here would drop that status to
 * "no desktop" and stop the reducer from locking next to a locked desktop —
 * fail-open. Reachability is what `desktopSync.isDesktopAvailable()` has always
 * meant, and `available:false` only ever arrives with `locked:true`.
 */
function toSnapshot(status: DesktopStatus | null): DesktopSnapshot | null {
	if (!status) {
		return null;
	}
	return {
		connected: true,
		locked: status.locked,
		unlockedAccountIds: status.unlockedAccounts ?? [],
		autoLockTimeoutMs: status.autolockTimeoutMs ?? null,
	};
}

export function createDesktopAdapter(): DesktopPort {
	return {
		readCached(): DesktopSnapshot | null {
			return toSnapshot(desktopSync.getLastStatus());
		},
		async refresh(): Promise<DesktopSnapshot | null> {
			return toSnapshot(await desktopSync.checkDesktopStatus());
		},
	};
}
