import { createRoute, redirect } from "@tanstack/react-router";
import { isDesktopStatusUnlocked } from "../background/desktop-protocol";
import { sendMessage } from "../lib/messaging";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/",
	beforeLoad: async () => {
		// Check auth status via background worker
		const response = await sendMessage({ type: "CHECK_AUTH" });

		if (response.success && response.authenticated) {
			throw redirect({ to: "/vault" });
		}

		const desktopStatusResponse = await sendMessage({
			type: "CHECK_DESKTOP_STATUS",
		});
		const desktopAvailable =
			desktopStatusResponse.success && desktopStatusResponse.available;
		const desktopUnlocked =
			desktopStatusResponse.success &&
			isDesktopStatusUnlocked(desktopStatusResponse);

		if (desktopUnlocked) {
			throw redirect({ to: "/vault" });
		}

		// Check whether Device-bound Secret Key and KDF inputs can reauthenticate online.
		const quickUnlockResponse = await sendMessage({ type: "CAN_QUICK_UNLOCK" });

		if (quickUnlockResponse.success && quickUnlockResponse.canQuickUnlock) {
			throw redirect({ to: "/unlock" });
		}

		if (desktopAvailable) {
			// Desktop is available - redirect to unlock screen
			// User can unlock via desktop (biometric or password)
			throw redirect({ to: "/unlock" });
		}

		// No session, no desktop - show login screen
		throw redirect({ to: "/login" });
	},
});
