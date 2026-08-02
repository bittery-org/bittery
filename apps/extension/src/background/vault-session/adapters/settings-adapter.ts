/** Reads the user's auto-lock preference; the desktop's value wins in the reducer. */

import { storage } from "../../../lib/storage";
import type { SettingsPort } from "../ports";

export function createSettingsAdapter(): SettingsPort {
	return {
		readAutoLockTimeoutMs(): Promise<number> {
			return storage.getAutoLockTimeoutOrDefault();
		},
	};
}
