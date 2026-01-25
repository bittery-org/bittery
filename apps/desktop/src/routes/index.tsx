import { storage } from "@/lib/storage";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Check for accounts
		const accountsList = await storage.getAccountsList();

		if (accountsList.length === 0) {
			// No accounts, go to login
			throw redirect({ to: "/login" });
		}

		// Get active account
		let activeEmail = await storage.getActiveAccountEmail();
		if (!activeEmail) {
			// Has accounts but none active, set first as active
			await storage.setActiveAccount(accountsList[0].email);
			activeEmail = accountsList[0].email;
		}

		// Check if active account has valid session
		const sessionValid = await storage.isSessionValid(activeEmail);

		if (sessionValid) {
			// Try to restore session
			const restored = await storage.tryRestoreSession(true, activeEmail);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		// Session not valid or restore failed, go to unlock
		throw redirect({ to: "/unlock", search: { email: activeEmail } });
	},
});
