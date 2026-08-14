import { m } from "@bittery/i18n/paraglide/messages";
import { toast } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter } from "@tanstack/react-router";
import { isBackgroundEvent } from "../background/events";

/**
 * Subscribed at module scope, not from an effect: pushes sent while the popup is
 * still mounting would otherwise be dropped.
 */
export function subscribeBackgroundPushes(
	queryClient: QueryClient,
	router: RegisteredRouter,
): void {
	chrome.runtime.onMessage.addListener((message: unknown) => {
		if (!isBackgroundEvent(message)) {
			return;
		}

		switch (message.type) {
			case "DESKTOP_LOCKED":
			case "VAULT_LOCKED": {
				queryClient.clear();
				router.navigate({ to: "/unlock" });
				break;
			}
			case "SESSION_REVOKED": {
				queryClient.clear();
				router.navigate({ to: "/unlock" });
				toast.error(m.ext_toast_session_revoked());
				break;
			}
			case "DESKTOP_UNLOCKED": {
				queryClient.clear();
				router.navigate({ to: "/vault" });
				break;
			}
			case "ACTIVE_ACCOUNT_CHANGED": {
				void Promise.all([
					queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
					queryClient.invalidateQueries({ queryKey: ["items"] }),
					queryClient.invalidateQueries({ queryKey: ["accounts"] }),
					queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
					queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] }),
				]);
				break;
			}
		}
	});
}
