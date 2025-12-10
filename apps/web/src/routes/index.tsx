import { isAuthenticated } from "@bittery/crypto";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: IndexComponent,
	beforeLoad: () => {
		if (!isAuthenticated()) {
			throw redirect({ to: "/login" });
		}

		// Redirect to vault page as main app view
		throw redirect({ to: "/home" });
	},
});

function IndexComponent() {
	return null;
}
