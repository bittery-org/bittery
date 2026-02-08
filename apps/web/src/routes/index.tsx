import { createFileRoute, redirect } from "@tanstack/react-router";
import { storage } from "@/lib/storage";

export const Route = createFileRoute("/")({
	component: IndexComponent,
	beforeLoad: async () => {
		if (!(await storage.isAuthenticated())) {
			throw redirect({ to: "/login" });
		}

		// Redirect to vault page as main app view
		throw redirect({ to: "/home" });
	},
});

function IndexComponent() {
	return null;
}
