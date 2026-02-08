import { createRoute, redirect } from "@tanstack/react-router";
import { VaultPage } from "../pages/vault";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/vault",
	component: VaultPage,
	beforeLoad: async () => {
		// Check if still authenticated and unlocked
		const authResponse = await chrome.runtime.sendMessage({
			type: "CHECK_AUTH",
		});

		if (authResponse.unlocked) {
			return;
		}

		// In desktop mode we can proceed even if extension-local unlock state is not restored yet.
		const desktopStatus = await chrome.runtime.sendMessage({
			type: "CHECK_DESKTOP_STATUS",
		});
		const desktopUnlocked =
			desktopStatus.success &&
			desktopStatus.available &&
			desktopStatus.locked === false &&
			(desktopStatus.unlockedAccounts?.length ?? 0) > 0;

		if (desktopUnlocked) {
			return;
		}

		// Check if we have a session that can be unlocked
		const canQuickUnlock = await chrome.runtime.sendMessage({
			type: "CAN_QUICK_UNLOCK",
		});

		if (canQuickUnlock.canQuickUnlock) {
			throw redirect({ to: "/unlock" });
		}

		if (desktopStatus.success && desktopStatus.available) {
			// Desktop is available but currently locked.
			throw redirect({ to: "/unlock" });
		}

		// No session, no desktop - redirect to login
		throw redirect({ to: "/login" });
	},
});
