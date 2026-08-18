import {
	createFileRoute,
	Outlet,
	redirect,
	useRouterState,
} from "@tanstack/react-router";
import { BottomTabBar } from "@/components/vault/bottom-tab-bar";
import { storage } from "@/lib/storage";
import { tabKeyForPath } from "@/lib/tab-route";
import { resolveVaultRouteAccess } from "@/lib/vault-route-access";

export const Route = createFileRoute("/vault")({
	component: VaultLayout,
	beforeLoad: async ({ context }) => {
		const access = await resolveVaultRouteAccess(
			context.runtime.accounts,
			storage,
		);
		if (access === "login") {
			throw redirect({ to: "/login" });
		}
		if (access === "unlock") {
			throw redirect({ to: "/unlock" });
		}
	},
});

function VaultLayout() {
	// `__root.tsx` already pads `--safe-top`. `--safe-bottom` is owned by the tab bar /
	// sheets / FAB (so the chrome can paint into the nav-bar area). Only the horizontal
	// insets (landscape, curved/notched edges) are added here.
	//
	// The tab bar sits here, not on each `TabScreen`, so switching Items / Browse /
	// Settings keeps the same DOM node. Pushed screens have no key and the bar unmounts.
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const activeTab = tabKeyForPath(pathname);

	return (
		<div
			className="flex h-full min-h-0 w-full flex-1 flex-col"
			style={{
				paddingLeft: "var(--safe-left)",
				paddingRight: "var(--safe-right)",
			}}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<Outlet />
			</div>
			{activeTab ? <BottomTabBar active={activeTab} /> : null}
		</div>
	);
}
