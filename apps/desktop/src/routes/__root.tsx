import { Toaster } from "@bittery/ui";
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
	component: RootComponent,
});

function RootComponent() {
	// Activity tracking happens automatically via DOM listeners in autolock service
	// No additional action needed on route navigation

	return (
		<div className="h-screen w-screen overflow-hidden">
			<Outlet />
			<Toaster />
		</div>
	);
}
