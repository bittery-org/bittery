import type { Context } from "hono";

const PERMISSIONS_POLICY =
	"accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": PERMISSIONS_POLICY,
	"X-XSS-Protection": "0",
	"X-Permitted-Cross-Domain-Policies": "none",
} as const;

function isSensitivePath(path: string): boolean {
	return (
		path === "/" ||
		path === "/healthz" ||
		path.startsWith("/trpc/") ||
		path.startsWith("/sync/") ||
		path.startsWith("/webhooks/")
	);
}

function isCdnPath(path: string): boolean {
	return path.startsWith("/cdn/");
}

export function applySecurityHeaders(context: Context): void {
	const path = context.req.path;

	if (isCdnPath(path)) {
		return;
	}

	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		context.header(name, value);
	}

	if (isSensitivePath(path)) {
		context.header("Cache-Control", "no-store, max-age=0");
		context.header("Pragma", "no-cache");
		context.header("Expires", "0");
	}
}

export async function securityHeadersMiddleware(
	context: Context,
	next: () => Promise<void>,
): Promise<void> {
	await next();
	applySecurityHeaders(context);
}

export function handleServerError(error: Error, context: Context): Response {
	console.error("Unhandled server error:", error);
	applySecurityHeaders(context);
	return context.json({ error: "Internal Server Error" }, 500);
}
