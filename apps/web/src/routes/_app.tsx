import { isAuthenticated } from "@bittery/crypto/session-storage";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { MobileNav, Sidebar } from "@/components/layout/sidebar";

export const Route = createFileRoute("/_app")({
	component: AppLayout,
	beforeLoad: () => {
		if (!isAuthenticated()) {
			throw redirect({ to: "/login" });
		}
	},
});

function AppLayout() {
	return (
		<div className="flex h-screen bg-background">
			<Sidebar />
			<div className="flex flex-1 flex-col overflow-hidden">
				<header className="flex h-14 items-center gap-4 border-b bg-background px-4 lg:hidden">
					<MobileNav />
					<span className="font-bold">Bittery</span>
				</header>
				<main className="flex-1 overflow-auto p-4 lg:p-6">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
