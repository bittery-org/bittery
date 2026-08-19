import { createRoute } from "@tanstack/react-router";
import { SettingsPage } from "../pages/settings";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/settings",
	component: SettingsPage,
});
