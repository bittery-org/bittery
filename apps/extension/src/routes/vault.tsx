import { createRoute } from "@tanstack/react-router";
import { VaultPage } from "../pages/vault";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/vault",
	component: VaultPage,
});
