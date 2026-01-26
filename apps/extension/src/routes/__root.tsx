import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
	component: () => (
		<div className="h-[520px] w-[620px] overflow-y-auto bg-background">
			<Outlet />
		</div>
	),
});
