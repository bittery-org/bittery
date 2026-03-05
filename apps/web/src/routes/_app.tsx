import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
	// SyncStatusIndicator,
} from "@bittery/ui";
import {
	createFileRoute,
	Outlet,
	redirect,
	useRouterState,
} from "@tanstack/react-router";
import { AppSidebar } from "@/components/layout/sidebar";
import { RevealLoader } from "@/components/loader";
import { useVaultKeysSync } from "@/hooks/use-vault-keys-sync";
import { storage } from "@/lib/storage";
// import { useSyncContextOptional } from "@/providers/sync-provider";

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
	// const syncContext = useSyncContextOptional();

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
					className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 pt-14 lg:pl-13 xl:pt-3.5"
				>
					<Outlet />
				</div>
			</SidebarInset>
			<RevealLoader isLoading={isLoading} />
		</SidebarProvider>
	);
}
