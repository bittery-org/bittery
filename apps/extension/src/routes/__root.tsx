import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
	component: () => (
		<div className="min-h-[400px] w-[375px]">
			<Outlet />
		</div>
	),
});
