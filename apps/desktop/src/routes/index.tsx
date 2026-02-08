import { createFileRoute, redirect } from "@tanstack/react-router";
import { storage } from "@/lib/storage";

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
				email: accountsList[0].email,
			});
			activeAccount = { type: "single", email: accountsList[0].email };
		}

		// Handle "All Accounts" mode specially
		if (activeAccount.type === "all") {
			// Check if we have any unlocked accounts
			const unlockedAccounts = await storage.getUnlockedAccounts?.();
			if (unlockedAccounts && unlockedAccounts.length > 0) {
				// At least one account is unlocked, go to vault
				throw redirect({ to: "/vault" });
			}
			// No unlocked accounts, redirect to unlock
			throw redirect({ to: "/unlock" });
		}

		// Single account mode: check if active account has valid session
		const sessionValid = await storage.isSessionValid(activeAccount.email);

		if (sessionValid) {
			// Try to restore session
			const restored = await storage.tryRestoreSession(
				true,
				activeAccount.email,
			);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		// Session not valid or restore failed, go to unlock
		throw redirect({ to: "/unlock", search: { email: activeAccount.email } });
	},
});
