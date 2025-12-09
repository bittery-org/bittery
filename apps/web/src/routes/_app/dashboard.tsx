import { createFileRoute, redirect } from "@tanstack/react-router";
import { isAuthenticated } from "@/lib/crypto";

export const Route = createFileRoute("/_app/dashboard")({
	component: RouteComponent,
	beforeLoad: () => {
		if (!isAuthenticated()) {
			throw redirect({ to: "/login" });
		}
		// Redirect to vault page as main app view
		throw redirect({ to: "/vault" });
	},
});

function RouteComponent() {
	return null;
}
