import { createRoute } from "@tanstack/react-router";
import { LoginPage } from "../pages/login";
import { Route as RootRoute } from "./__root";

interface LoginSearchParams {
	addingAccount?: boolean;
}

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/login",
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => {
		return {
			addingAccount:
				search.addingAccount === true || search.addingAccount === "true",
		};
	},
});
