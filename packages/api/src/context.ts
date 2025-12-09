import { verifySession } from "@bittery/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

export async function createContext({ context }: CreateContextOptions) {
	// Extract JWT token from Authorization header
	const authHeader = context.req.header("Authorization");
	const token = authHeader?.replace("Bearer ", "");

	let session = null;
	if (token) {
		session = await verifySession(token);
	}

	return {
		session,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
