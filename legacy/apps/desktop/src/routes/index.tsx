import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	beforeLoad: async ({ context }) => {
		// Check for accounts
		const accountsList = context.runtime.accounts.getAccounts();

		const [firstAccount] = accountsList;
		if (!firstAccount) {
			// No accounts, go to login
			throw redirect({ to: "/login" });
		}

		// Get active account
		let activeAccount = context.runtime.accounts.getActiveAccount();

		if (!activeAccount) {
			// Has accounts but none active, set first as active
			await context.runtime.accounts.switchAccount(firstAccount.accountId);
			activeAccount = firstAccount.accountId;
		}

		// Single account mode: check if the active account has a valid session.
		const sessionValid =
			await context.runtime.accounts.storage.isSessionValid(activeAccount);

		if (sessionValid) {
			const restored = await context.runtime.accounts.unlockAccount(
				activeAccount,
				true,
			);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		// Session not valid or restore failed, go to unlock
		throw redirect({ to: "/unlock" });
	},
});
