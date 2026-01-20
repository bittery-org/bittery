import { verifySession } from "@bittery/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

export interface DeviceContext {
	userAgent: string;
	ipAddress: string | null;
}

export async function createContext({ context }: CreateContextOptions) {
	// Extract JWT token from Authorization header
	const authHeader = context.req.header("Authorization");
	const token = authHeader?.replace("Bearer ", "");

	let session = null;
	if (token) {
		session = await verifySession(token);
	}

	// Extract device information from request headers
	const userAgent = context.req.header("User-Agent") || "";
	// Get IP address from various headers (Cloudflare, proxies, direct)
	const ipAddress =
		context.req.header("CF-Connecting-IP") ||
		context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
		context.req.header("X-Real-IP") ||
		null;

	return {
		session,
		device: {
			userAgent,
			ipAddress,
		} as DeviceContext,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
