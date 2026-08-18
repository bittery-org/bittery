import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { storage } from "@/lib/storage";
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
	// `__root.tsx` already pads its wrapper by `--safe-top` / `--safe-bottom`, so only the
	// horizontal insets (relevant in landscape, or on devices with curved/notched edges) are
	// added here — see `MobileScreen`'s doc comment for why top/bottom aren't repeated.
	return (
		<div
			className="flex h-full min-h-0 w-full flex-1 flex-col"
			style={{
				paddingLeft: "var(--safe-left)",
				paddingRight: "var(--safe-right)",
			}}
		>
			<Outlet />
		</div>
	);
}
