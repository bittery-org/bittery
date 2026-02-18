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
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<header className="flex h-16 shrink-0 items-center gap-2">
					<div className="flex items-center gap-2 px-5">
						<SidebarTrigger className="-ml-1" />
					</div>
					<div className="ml-auto px-5">
						{/* {syncContext ? (
							<SyncStatusIndicator
								status={syncContext.status.connectionStatus}
							/>
						) : null} */}
					</div>
				</header>
				<div className="flex flex-1 flex-col gap-4 px-5 py-4 pt-0">
					<Outlet />
				</div>
			</SidebarInset>
			<RevealLoader isLoading={isLoading} />
		</SidebarProvider>
	);
}
