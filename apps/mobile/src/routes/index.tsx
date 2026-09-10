import { createFileRoute, redirect } from "@tanstack/react-router";
import { BrandSplash } from "@/components/auth-kit";
import { Screen } from "@/components/ui";
import { storage } from "@/lib/storage";
import { resolveVaultRouteAccess } from "@/lib/vault-route-access";

export const Route = createFileRoute("/")({
	/**
	 * The launcher icon, and the whole reason `resolveVaultRouteAccess` exists.
	 *
	 * This used to carry its own copy of the decision — accounts list, adopt the first
	 * account, `isSessionValid`, `unlockAccount(id, true)` — which was right for every
	 * cold start except the one the user notices: unlock in Bittery's own autofill sheet,
	 * come back to the app, get asked for the password again. Only the shared decision
	 * borrows the live native key, so only the shared decision can answer that. `/vault`
	 * and `/login` ask the same question of the same function.
	 */
	beforeLoad: async ({ context }) => {
		const access = await resolveVaultRouteAccess(
			context.runtime.accounts,
			storage,
		);
		if (access === "login") {
			throw redirect({ to: "/login" });
		}
		if (access === "unlock") {
			throw redirect({ to: "/unlock" });
		}
		throw redirect({ to: "/vault" });
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
