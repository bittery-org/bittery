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

		// Check if quick unlock is available
		const quickUnlockResponse = await chrome.runtime.sendMessage({
			type: "CAN_QUICK_UNLOCK",
		});

		if (quickUnlockResponse.canQuickUnlock) {
			throw redirect({ to: "/unlock" });
		}

		throw redirect({ to: "/login" });
	},
});
