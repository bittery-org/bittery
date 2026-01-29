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

		// If not unlocked (even if authenticated), redirect to unlock screen
		if (!authResponse.unlocked) {
			// Check if we have a session that can be unlocked
			const canQuickUnlock = await chrome.runtime.sendMessage({
				type: "CAN_QUICK_UNLOCK",
			});

			if (canQuickUnlock.canQuickUnlock) {
				// Has session, redirect to unlock
				throw redirect({ to: "/unlock" });
			}

			// Check if desktop is available
			const desktopStatus = await chrome.runtime.sendMessage({
				type: "CHECK_DESKTOP_STATUS",
			});

			if (desktopStatus.success && desktopStatus.available) {
				// Desktop available, redirect to unlock (can unlock via desktop)
				throw redirect({ to: "/unlock" });
			}

			// No session, no desktop - redirect to login
			throw redirect({ to: "/login" });
		}
	},
});
