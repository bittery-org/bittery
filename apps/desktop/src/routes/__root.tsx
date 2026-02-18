import { Toaster } from "@bittery/ui";
import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthRevealLoader } from "@/components/auth/auth-reveal-loader";
import { subscribeAuthRevealToVault } from "@/lib/auth-reveal-transition";

export const Route = createRootRoute({
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
