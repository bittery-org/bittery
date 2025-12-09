import { createMiddleware } from "@tanstack/react-start";

export const authMiddleware = createMiddleware().server(
	async ({ next, request }) => {
		// For server-side rendering, we need to get token from cookie
		// For now, return null - actual auth check happens client-side
		const session = null;

		return next({
			context: { session },
		});
	},
);
