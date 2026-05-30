import { createRouter } from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
export const getRouter = () => {
	const router = createRouter({
		routeTree,
		context: {},
		defaultPreloadStaleTime: 0,
	});

	if (typeof window !== "undefined") {
		window.history.scrollRestoration = "manual";

		router.subscribe("onResolved", () => {
			window.scrollTo({ top: 0, left: 0, behavior: "instant" });
		});
	}

	return router;
};
