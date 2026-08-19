import { cn, SidebarInset, SidebarProvider, SidebarTrigger } from "@bittery/ui";
import {
	createFileRoute,
	Outlet,
	redirect,
	useMatch,
	useRouterState,
} from "@tanstack/react-router";
import { AppSidebar } from "@/components/layout/sidebar";
import { RevealLoader } from "@/components/loader";
import { useVaultKeysSync } from "@/hooks/use-vault-keys-sync";
import { storage } from "@/lib/storage";

export const Route = createFileRoute("/_app")({
	component: AppLayout,
	beforeLoad: async () => {
		if (!(await storage.isAuthenticated())) {
			throw redirect({ to: "/login" });
		}
	},
});

function AppLayout() {
	useVaultKeysSync();
	const isLoading = useRouterState({ select: (s) => s.isLoading });
	const isVaultsRoute = !!useMatch({
		from: "/_app/vaults",
		shouldThrow: false,
	});

	return (
		<SidebarProvider className="h-svh overflow-hidden">
			<AppSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="absolute top-0 z-[50] flex h-11 shrink-0 items-center gap-2 xl:h-12">
					<div className="flex items-center gap-2 px-4">
						<SidebarTrigger className="-ml-1" />
					</div>
				</header>
				<div
					id="app-scroll-area"
					className={cn(
						"flex min-h-0 flex-1 flex-col",
						isVaultsRoute
							? "overflow-hidden"
							: "gap-4 overflow-y-auto px-5 pt-11 pb-4 lg:pl-13 xl:pt-12",
					)}
				>
					<Outlet />
				</div>
			</SidebarInset>
			<RevealLoader isLoading={isLoading} />
		</SidebarProvider>
	);
}
