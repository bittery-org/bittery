import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { itemCache, storage } from "@/lib/storage";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Check for accounts
		const accountsList = await storage.getAccountsList();

		if (accountsList.length === 0) {
			// No accounts, go to login
			throw redirect({ to: "/login" });
		}

		// Get active account
		let activeAccount = await storage.getActiveAccount();

		if (!activeAccount) {
			// Has accounts but none active, set first as active
			await storage.setActiveAccount({
				type: "single",
				accountId: accountsList[0].accountId,
			});
			activeAccount = {
				type: "single",
				accountId: accountsList[0].accountId,
			};
		}

		// Single account mode: check if active account has valid session
		const activeAccountEmail = accountsList.find(
			(account) => account.accountId === activeAccount.accountId,
		)?.email;
		const sessionValid = await storage.isSessionValid(activeAccount.accountId);

		if (sessionValid) {
			// Try to restore session
			const restored = await getAccountSessionManager({
				storage,
				itemCache,
			}).unlockAccount(activeAccount.accountId, true);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		// Session not valid or restore failed, go to unlock
		throw redirect({
			to: "/unlock",
			search: activeAccountEmail ? { email: activeAccountEmail } : undefined,
		});
	},
});
