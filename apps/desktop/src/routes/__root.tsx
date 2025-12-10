import { Toaster } from "@bittery/ui";
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
	component: () => (
		<div className="h-screen w-screen overflow-hidden">
			<Outlet />
			<Toaster />
		</div>
	),
});
