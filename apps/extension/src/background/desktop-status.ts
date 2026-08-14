/**
 * Desktop Status
 *
 * Single home for reading desktop lock/unlock status. Prefer the cached
 * status from `desktopSync` and only fall back to a fresh native-messaging
 * round trip when nothing has been fetched yet, or when a caller explicitly
 * needs an up-to-date read (see `refresh`).
 */

import {
	type DesktopStatus,
	isDesktopStatusUnlocked,
} from "./desktop-protocol";
import { getDesktopSync } from "./desktop-sync";

/**
 * Get the current desktop status.
 *
 * By default returns the last cached status if one exists, only issuing a
 * fresh `checkDesktopStatus()` call when nothing has been cached yet. Pass
 * `{ refresh: true }` to force a fresh check regardless of cache state.
 */
export async function getDesktopStatus(opts?: {
	refresh?: boolean;
}): Promise<DesktopStatus | null> {
	if (opts?.refresh) {
		return getDesktopSync().checkDesktopStatus();
	}

	const desktopSync = getDesktopSync();
	return (
		desktopSync.getLastStatus() ?? (await desktopSync.checkDesktopStatus())
	);
}

/**
 * True when the desktop app is available, unlocked, and has at least one
 * unlocked account.
 */
export async function isDesktopUnlockedNow(): Promise<boolean> {
	const status = await getDesktopStatus();
	return isDesktopStatusUnlocked(status);
}

/**
 * True when the desktop app is available and unlocked (ignores whether any
 * accounts are unlocked). Used to gate desktop-backed vault reads.
 */
export async function isDesktopReadAvailable(): Promise<boolean> {
	const status = await getDesktopStatus();
	return Boolean(status?.available && !status.locked);
}

/**
 * True when a desktop app is connected but locked. This is the state where the
 * extension must not unlock on its own — see `desktop-unlock.ts`.
 */
export async function isDesktopLockedNow(): Promise<boolean> {
	const status = await getDesktopStatus();
	return Boolean(status?.available && status.locked);
}
