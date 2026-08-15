import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

// Empty for now; later chunks add apiClient/queryClient/runtime.
export type MobileRouterContext = Record<string, never>;

export const Route = createRootRouteWithContext<MobileRouterContext>()({
	component: RootComponent,
});

function RootComponent() {
	return (
		<div className="min-h-dvh bg-background text-foreground">
			<Outlet />
		</div>
	);
}
