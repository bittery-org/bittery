import { createRoute } from "@tanstack/react-router";
import { UnlockPage } from "../pages/unlock";
import { Route as RootRoute } from "./__root";

interface UnlockSearchParams {
	email?: string;
}

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/unlock",
	component: UnlockPage,
	validateSearch: (search: Record<string, unknown>): UnlockSearchParams => {
		return {
			email: typeof search.email === "string" ? search.email : undefined,
		};
	},
});
