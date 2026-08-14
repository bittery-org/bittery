import type { ApiClient } from "@bittery/api-contract";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { Toaster } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	Outlet,
	useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthRevealLoader } from "@/components/auth/auth-reveal-loader";
import { subscribeAuthRevealToVault } from "@/lib/auth-reveal-transition";

export interface DesktopRouterContext {
	apiClient: ApiClient;
	queryClient: QueryClient;
	runtime: ClientRuntime;
}

export const Route = createRootRouteWithContext<DesktopRouterContext>()({
	component: RootComponent,
});

function RootComponent() {
	// Activity tracking happens automatically via DOM listeners in autolock service
	// No additional action needed on route navigation
	const navigate = useNavigate();
	const [isAuthRevealing, setIsAuthRevealing] = useState(false);

	useEffect(() => {
		return subscribeAuthRevealToVault(() => {
			setIsAuthRevealing(true);
			void navigate({ to: "/vault" });
		});
	}, [navigate]);

	return (
		<div className="h-screen w-screen overflow-hidden">
			<Outlet />
			<Toaster />
			<AuthRevealLoader
				isVisible={isAuthRevealing}
				onComplete={() => {
					setIsAuthRevealing(false);
				}}
			/>
		</div>
	);
}
