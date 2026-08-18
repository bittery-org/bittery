import type { ApiClient } from "@bittery/api-contract";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { Toaster } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { syncSystemBars } from "@/lib/system-bars";

export interface MobileRouterContext {
	apiClient: ApiClient;
	queryClient: QueryClient;
	runtime: ClientRuntime;
}

export const Route = createRootRouteWithContext<MobileRouterContext>()({
	component: RootComponent,
});

/**
 * One of the few honest uses of `useEffect` in this app: pushing a React value into a system
 * outside React — here the Android window's bar appearance. It has to react to `resolvedTheme`,
 * which covers both the in-app Dark Mode switch and a system night-mode change, so an event
 * handler on the switch alone would miss half of it.
 */
function SystemBarsSync() {
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		// Before `next-themes` resolves, the class it already put on <html> carries the same fact.
		const isDark = resolvedTheme
			? resolvedTheme === "dark"
			: document.documentElement.classList.contains("dark");
		syncSystemBars(isDark);
	}, [resolvedTheme]);

	return null;
}

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
			<SystemBarsSync />
			<Outlet />
			{/*
			 * Sonner's default bottom offset lands the toast on top of the tab bar and the
			 * FAB. Lift it clear of both, and of the home indicator below them.
			 */}
			<Toaster
				offset={{
					bottom: "calc(var(--tab-bar-height) + var(--safe-bottom) + 16px)",
				}}
				mobileOffset={{
					bottom: "calc(var(--tab-bar-height) + var(--safe-bottom) + 16px)",
					left: "12px",
					right: "12px",
				}}
			/>
		</div>
	);
}
