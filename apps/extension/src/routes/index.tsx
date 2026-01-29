import { createRoute, redirect } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/",
	beforeLoad: async () => {
		// Check auth status via background worker
		const response = await chrome.runtime.sendMessage({
			type: "CHECK_AUTH",
		});

		if (response.authenticated) {
			throw redirect({ to: "/vault" });
		}

		// Check if quick unlock is available (has stored session)
		const quickUnlockResponse = await chrome.runtime.sendMessage({
			type: "CAN_QUICK_UNLOCK",
		});

		if (quickUnlockResponse.canQuickUnlock) {
			throw redirect({ to: "/unlock" });
		}

		// Check if desktop is available with accounts
		// Even if no local session, we should show unlock screen if desktop has accounts
		const desktopStatusResponse = await chrome.runtime.sendMessage({
			type: "CHECK_DESKTOP_STATUS",
		});

		if (desktopStatusResponse.success && desktopStatusResponse.available) {
			// Desktop is available - redirect to unlock screen
			// User can unlock via desktop (biometric or password)
			throw redirect({ to: "/unlock" });
		}

		// No session, no desktop - show login screen
		throw redirect({ to: "/login" });
	},
});
