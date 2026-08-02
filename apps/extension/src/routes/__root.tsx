import { createRootRoute, Outlet } from "@tanstack/react-router";
import { initializeStorage } from "@/lib/storage";

export const Route = createRootRoute({
	// Runs ahead of every other route guard and loader, so the popup's own
	// `AccountStore` / `ItemCache` pair is initialized before the first read.
	beforeLoad: () => initializeStorage(),
	component: () => (
		<div className="h-[520px] w-[620px] overflow-y-auto bg-background">
			<Outlet />
		</div>
	),
});
