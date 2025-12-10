import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";
import { UnlockPage } from "../pages/unlock";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/unlock",
	component: UnlockPage,
});
