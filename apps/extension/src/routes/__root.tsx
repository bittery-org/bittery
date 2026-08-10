import { createRootRoute, Outlet } from "@tanstack/react-router";
import { initializeStorage, storage } from "@/lib/storage";

/**
 * The popup gets its own `AccountStore`, so its master unlock key cache starts empty on
 * every open while `session_data` survives in `chrome.storage.local`. Reading the key
 * never restores it, so the popup reopens the session itself — without a prompt, which
 * only the service worker's unlock flows may raise.
 */
async function bootPopupStorage(): Promise<void> {
	await initializeStorage();
	for (const account of await storage.getAccountsList()) {
		await storage.tryRestoreSessionWithoutPrompt(account.accountId);
	}
}

export const Route = createRootRoute({
	// Runs ahead of every other route guard and loader, so the popup's own
	// `AccountStore` / `ItemCache` pair is initialized before the first read.
	beforeLoad: () => bootPopupStorage(),
	component: () => (
		<div className="h-[520px] w-[620px] overflow-y-auto bg-background">
			<Outlet />
		</div>
	),
});
