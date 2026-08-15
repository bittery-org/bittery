import type { ApiClient } from "@bittery/api-contract";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { Toaster } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

export interface MobileRouterContext {
	apiClient: ApiClient;
	queryClient: QueryClient;
	runtime: ClientRuntime;
}

export const Route = createRootRouteWithContext<MobileRouterContext>()({
	component: RootComponent,
});

function RootComponent() {
	// Activity tracking happens automatically via the mobile autolock service's
	// AppState listener. No additional action needed on route navigation.
	//
	// No `AuthRevealLoader` / `subscribeAuthRevealToVault` here — that is desktop's
	// two-panel opening-doors reveal transition into the vault. Mobile screens
	// navigate to `/vault` directly on success.
	return (
		<div
			className="min-h-dvh w-full overflow-hidden bg-background text-foreground"
			style={{
				paddingTop: "var(--safe-top)",
				paddingBottom: "var(--safe-bottom)",
			}}
		>
			<Outlet />
			<Toaster />
		</div>
	);
}
