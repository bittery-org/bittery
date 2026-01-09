import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Check for accounts
		const accountsList = await tauriStorage.getAccountsList();

		if (accountsList.accounts.length === 0) {
			// No accounts, go to login
			throw redirect({ to: "/login" });
		}

		// Get active account
		let activeEmail = await tauriStorage.getActiveAccountEmail();
		if (!activeEmail) {
			// Has accounts but none active, set first as active
			await tauriStorage.setActiveAccount(accountsList.accounts[0].email);
			activeEmail = accountsList.accounts[0].email;
		}

		// Check if active account has valid session
		const sessionValid = await tauriStorage.isSessionValid(activeEmail);

		if (sessionValid) {
			// Try to restore session
			const restored = await tauriStorage.tryRestoreSession(true, activeEmail);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		// Session not valid or restore failed, go to unlock
		throw redirect({ to: "/unlock", search: { email: activeEmail } });
	},
});
