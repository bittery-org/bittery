import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "@bittery/ui";

export const Route = createRootRoute({
	component: () => (
		<div className="h-screen w-screen overflow-hidden">
			<Outlet />
			<Toaster />
		</div>
	),
});
