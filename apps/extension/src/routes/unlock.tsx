import { createRoute } from "@tanstack/react-router";
import { UnlockPage } from "../pages/unlock";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/unlock",
	component: UnlockPage,
});
