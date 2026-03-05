import { verifySession } from "@bittery/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

export interface DeviceContext {
	userAgent: string;
	ipAddress: string | null;
	appPlatform: string | null;
}

export async function createContext({ context }: CreateContextOptions) {
	// Extract session token from Authorization header
	const authHeader = context.req.header("Authorization");
	const token = authHeader?.replace("Bearer ", "");

	let session = null;
	if (token) {
		session = await verifySession(token);
	}

	if (session) {
		context.header("X-Session-Expires", session.expiresAt.toISOString());
	}

	// Extract device information from request headers
	const userAgent = context.req.header("User-Agent") || "";
	// Get IP address from various headers (Cloudflare, proxies, direct)
	const ipAddress =
		context.req.header("CF-Connecting-IP") ||
		context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
		context.req.header("X-Real-IP") ||
		null;
	const clientId = context.req.header("X-Client-Id") ?? null;
	const appPlatform = context.req.header("X-App-Platform") ?? null;

	return {
		session,
		authToken: token ?? null,
		clientId,
		device: {
			userAgent,
			ipAddress,
			appPlatform,
		} as DeviceContext,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
