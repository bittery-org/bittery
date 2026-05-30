import { createRouter } from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
export const getRouter = () => {
	const router = createRouter({
		routeTree,
		context: {},
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
	});

	if (typeof window !== "undefined") {
		// Track back/forward navigation to avoid overriding scroll restoration
		let isPop = false;
		window.addEventListener("popstate", () => {
			isPop = true;
		});

		router.subscribe("onResolved", () => {
			// Let TanStack's scrollRestoration handle back/forward
			if (isPop) {
				isPop = false;
				return;
			}

			const hash = router.state.location.hash;
			if (hash) {
				document.getElementById(hash)?.scrollIntoView({ behavior: "instant" });
				return;
			}

			window.scrollTo({ top: 0, left: 0, behavior: "instant" });
		});
	}

	return router;
};
