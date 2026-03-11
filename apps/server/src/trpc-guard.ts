import type { Context, Next } from "hono";

export const TRPC_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

function isJsonContentType(contentType: string | undefined): boolean {
	if (!contentType) {
		return false;
	}

	return contentType.toLowerCase().startsWith("application/json");
}

export function isMutatingTrpcRequest(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export async function enforceTrpcRequestGuards(c: Context, next: Next) {
	if (!isMutatingTrpcRequest(c.req.method)) {
		return next();
	}

	if (!isJsonContentType(c.req.header("content-type"))) {
		return c.json(
			{
				error: "Unsupported Media Type",
			},
			415,
		);
	}

	const contentLengthHeader = c.req.header("content-length");
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10);
		if (
			Number.isFinite(contentLength) &&
			contentLength > TRPC_JSON_BODY_LIMIT_BYTES
		) {
			return c.json(
				{
					error: "Payload Too Large",
				},
				413,
			);
		}
	}

	const bodySize = (await c.req.raw.clone().arrayBuffer()).byteLength;
	if (bodySize > TRPC_JSON_BODY_LIMIT_BYTES) {
		return c.json(
			{
				error: "Payload Too Large",
			},
			413,
		);
	}

	return next();
}
