import { createRoute } from "@tanstack/react-router";
import { LoginPage } from "../pages/login";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/login",
	component: LoginPage,
});
