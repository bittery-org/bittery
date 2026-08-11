import { describe, expect, test } from "bun:test";
import {
	ApiError,
	isApiErrorStatus,
	isUnauthorizedApiError,
	normalizeApiError,
} from "../errors.ts";

describe("API problem errors", () => {
	test("classifies API error statuses without accepting lookalikes", () => {
		const error = new ApiError(
			{
				type: "https://bittery.com/problems/authentication-required",
				title: "Authentication required",
				status: 401,
				code: "AUTHENTICATION_REQUIRED",
			},
			null,
		);

		expect(isApiErrorStatus(error, 401)).toBe(true);
		expect(isUnauthorizedApiError(error)).toBe(true);
		expect(isApiErrorStatus({ status: 401 }, 401)).toBe(false);
	});

	test("normalizes a valid RFC 9457 response", async () => {
		const error = await normalizeApiError(
			new Response(
				JSON.stringify({
					type: "https://bittery.com/problems/version-conflict",
					title: "Version conflict",
					status: 412,
					code: "VERSION_CONFLICT",
					detail: "The item changed after it was loaded.",
					requestId: "req_123",
					retryable: false,
					errors: [{ pointer: "/expectedVersion", code: "STALE_VERSION" }],
				}),
				{
					status: 412,
					headers: { "Bittery-Request-Id": "req_header" },
				},
			),
		);

		expect(error.status).toBe(412);
		expect(error.code).toBe("VERSION_CONFLICT");
		expect(error.requestId).toBe("req_123");
		expect(error.errors).toEqual([
			{ pointer: "/expectedVersion", code: "STALE_VERSION" },
		]);
	});

	test("does not trust a body that disagrees with HTTP status", async () => {
		const error = await normalizeApiError(
			new Response(
				JSON.stringify({
					type: "https://bittery.com/problems/not-found",
					title: "Not found",
					status: 404,
					code: "NOT_FOUND",
				}),
				{ status: 403, statusText: "Forbidden" },
			),
		);

		expect(error.status).toBe(403);
		expect(error.code).toBe("HTTP_ERROR");
		expect(error.message).toBe("Forbidden");
	});

	test("parses delta-seconds Retry-After", async () => {
		const error = await normalizeApiError(
			new Response(null, { status: 429, headers: { "Retry-After": "12" } }),
		);

		expect(error.retryAfterSeconds).toBe(12);
	});

	test("parses HTTP-date Retry-After against the supplied clock", async () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const error = await normalizeApiError(
			new Response(null, {
				status: 503,
				headers: { "Retry-After": new Date(now + 1_200).toUTCString() },
			}),
			now,
		);

		expect(error.retryAfterSeconds).toBe(1);
	});
});
