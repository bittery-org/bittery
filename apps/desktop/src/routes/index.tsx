import { peekAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { storage } from "@/lib/storage";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Check for accounts
		const accountsList = await storage.getAccountsList();

		const [firstAccount] = accountsList;
		if (!firstAccount) {
			// No accounts, go to login
			throw redirect({ to: "/login" });
		}

		// Get active account
		let activeAccount = await storage.getActiveAccount();

		if (!activeAccount) {
			// Has accounts but none active, set first as active
			await storage.setActiveAccount(firstAccount.accountId);
			activeAccount = firstAccount.accountId;
		}

		// Single account mode: check if active account has valid session
		const activeAccountEmail = accountsList.find(
			(account) => account.accountId === activeAccount,
		)?.email;
		const sessionValid = await storage.isSessionValid(activeAccount);

		if (sessionValid) {
			// This guard can run before AccountProvider constructs the manager; with no
			// manager there is no verified unlock, so fall through to /unlock.
			const restored = await peekAccountSessionManager()?.unlockAccount(
				activeAccount,
				true,
			);
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
