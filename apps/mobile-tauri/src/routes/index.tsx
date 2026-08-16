import { createFileRoute, redirect } from "@tanstack/react-router";
import { BrandSplash } from "@/components/auth-kit";
import { Screen } from "@/components/ui";

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
	/**
	 * `beforeLoad` above reads storage and may restore a session, so this is the app's cold
	 * start — the first thing a user sees. `pendingMs: 0` paints the splash on the first
	 * frame instead of leaving the router's default second of blank canvas, and the default
	 * `pendingMinMs` then holds it long enough that a fast redirect does not strobe.
	 */
	pendingMs: 0,
	pendingComponent: SplashScreen,
	// `beforeLoad` always redirects, so this never renders in practice. It exists so a
	// future edit that lets one path fall through shows the splash rather than a blank app.
	component: SplashScreen,
});

function SplashScreen() {
	return (
		<Screen aurora>
			<BrandSplash />
		</Screen>
	);
}
