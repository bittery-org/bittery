import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";
import { VaultPage } from "../pages/vault";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/vault",
	component: VaultPage,
});
