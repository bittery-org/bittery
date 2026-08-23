import { describe, expect, test } from "bun:test";
import { WebHttpTransportExecutor } from "./web-http-transport-executor";

type FetchCall = {
	request: Request;
	resolve: (response: Response) => void;
	reject: (reason: unknown) => void;
};

function request(
	overrides: Partial<{
		dispatchId: string;
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
		url: string;
		headers: Array<{ name: string; value: string }>;
		body: number[];
		maxResponseBytes: number;
	}> = {},
): string {
	return JSON.stringify({
		dispatchId: "dispatch-1",
		method: "POST",
		url: "https://api.example.test/session",
		headers: [
			{ name: "content-type", value: "application/json" },
			{ name: "x-bittery-request", value: "one" },
		],
		body: [123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125],
		maxResponseBytes: 64,
		...overrides,
	});
}

function result(json: string): Record<string, unknown> {
	return JSON.parse(json) as Record<string, unknown>;
}

function deferredFetch() {
	const calls: FetchCall[] = [];
	const fetch = (input: RequestInfo | URL): Promise<Response> => {
		const request = input as Request;
		return new Promise((resolve, reject) => {
			calls.push({ request, resolve, reject });
			request.signal.addEventListener(
				"abort",
				() => reject(new DOMException("PRIVATE_ABORT_DETAIL", "AbortError")),
				{ once: true },
			);
		});
	};
	return { calls, fetch };
}

describe("WebHttpTransportExecutor", () => {
	test("executes Rust request bytes with a locked-down browser Request", async () => {
		let captured: Request | undefined;
		const executor = new WebHttpTransportExecutor(async (input) => {
			captured = input as Request;
			return new Response(Uint8Array.from([4, 5, 6]), {
				status: 201,
				headers: [
					["x-visible-z", "last"],
					["x-visible-a", "first"],
				],
			});
		});

		const response = result(await executor.invoke(request()));
		const actual = captured as Request | undefined;

		expect(actual).toBeDefined();
		if (actual === undefined)
			throw new Error("fetch did not receive a Request");
		expect(actual.url).toBe("https://api.example.test/session");
		expect(actual.method).toBe("POST");
		expect(actual.redirect).toBe("manual");
		expect(actual.cache).toBe("no-store");
		expect(actual.mode).toBe("cors");
		expect([...actual.headers.entries()]).toEqual([
			["content-type", "application/json"],
			["x-bittery-request", "one"],
		]);
		expect([...new Uint8Array(await actual.arrayBuffer())]).toEqual([
			123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125,
		]);
		expect(response).toEqual({
			type: "completed",
			status: 201,
			headers: [
				{ name: "x-visible-a", value: "first" },
				{ name: "x-visible-z", value: "last" },
			],
			body: [4, 5, 6],
		});
	});

	test("passes undefined for every empty body including GET and HEAD", async () => {
		const captured: Request[] = [];
		const executor = new WebHttpTransportExecutor(async (input) => {
			captured.push(input as Request);
			return new Response(null, { status: 204 });
		});

		await executor.invoke(request({ method: "GET", body: [] }));
		await executor.invoke(
			request({ dispatchId: "head", method: "HEAD", body: [] }),
		);
		await executor.invoke(
			request({ dispatchId: "post", method: "POST", body: [] }),
		);

		expect(captured.map(({ body }) => body)).toEqual([null, null, null]);
	});

	test("rejects nonempty GET and HEAD bodies instead of silently dropping bytes", async () => {
		let calls = 0;
		const executor = new WebHttpTransportExecutor(async () => {
			calls += 1;
			return new Response(null);
		});

		for (const [method, dispatchId] of [
			["GET", "get-body"],
			["HEAD", "head-body"],
		] as const) {
			await expect(
				executor.invoke(request({ dispatchId, method, body: [1] })),
			).rejects.toThrow("HTTP transport invocation failed");
		}
		expect(calls).toBe(0);
	});

	test("rejects case-insensitive duplicate request headers before fetch", async () => {
		let calls = 0;
		const executor = new WebHttpTransportExecutor(async () => {
			calls += 1;
			return new Response(null);
		});

		await expect(
			executor.invoke(
				request({
					headers: [
						{ name: "X-Bittery-Request", value: "one" },
						{ name: "x-bittery-request", value: "two" },
					],
				}),
			),
		).rejects.toThrow("HTTP transport invocation failed");
		expect(calls).toBe(0);
	});

	test("rejects header values that Request would silently normalize", async () => {
		let calls = 0;
		const executor = new WebHttpTransportExecutor(async () => {
			calls += 1;
			return new Response(null);
		});

		await expect(
			executor.invoke(
				request({
					headers: [{ name: "x-bittery-request", value: " silently-trimmed " }],
				}),
			),
		).rejects.toThrow("HTTP transport invocation failed");
		expect(calls).toBe(0);
	});

	test("returns redirects and opaque-style status for Rust policy", async () => {
		const responses = [
			new Response(null, { status: 307, headers: { location: "/next" } }),
			new Response(null),
		];
		Object.defineProperty(responses[1], "status", { value: 0 });
		const executor = new WebHttpTransportExecutor(
			async () => responses.shift() as Response,
		);

		expect(result(await executor.invoke(request())).status).toBe(307);
		expect(
			result(await executor.invoke(request({ dispatchId: "opaque" }))).status,
		).toBe(0);
	});

	test("redacts browser network errors", async () => {
		const executor = new WebHttpTransportExecutor(async () => {
			throw new Error("DNS_PRIVATE_HOST_DETAIL");
		});

		const response = await executor.invoke(request());
		expect(result(response)).toEqual({ type: "networkFailure" });
		expect(response).not.toContain("DNS_PRIVATE_HOST_DETAIL");
	});

	test("rejects oversized Content-Length without reading the body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(Uint8Array.from([1]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const executor = new WebHttpTransportExecutor(
			async () => new Response(body, { headers: { "content-length": "65" } }),
		);

		expect(result(await executor.invoke(request()))).toEqual({
			type: "responseTooLarge",
		});
		expect(cancelled).toBe(true);
	});

	test("stops a streaming response as soon as it crosses the byte limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.from([1, 2, 3]));
				controller.enqueue(Uint8Array.from([4, 5]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const executor = new WebHttpTransportExecutor(
			async () => new Response(body),
		);

		expect(
			result(await executor.invoke(request({ maxResponseBytes: 4 }))),
		).toEqual({ type: "responseTooLarge" });
		expect(cancelled).toBe(true);
	});

	test("cancels one dispatch and permits safe reuse after removal", async () => {
		const deferred = deferredFetch();
		const executor = new WebHttpTransportExecutor(deferred.fetch);
		const first = executor.invoke(request());
		await Promise.resolve();

		expect(() => executor.cancel("dispatch-1")).not.toThrow();
		const second = executor.invoke(request());
		await Promise.resolve();
		expect(deferred.calls).toHaveLength(2);
		deferred.calls[1]?.resolve(new Response(Uint8Array.from([9])));

		expect(result(await first)).toEqual({ type: "cancelled" });
		expect(result(await second)).toMatchObject({
			type: "completed",
			body: [9],
		});
		expect(() => executor.cancel("unknown")).not.toThrow();
	});

	test("rejects duplicate active dispatch IDs without cancelling the first", async () => {
		const deferred = deferredFetch();
		const executor = new WebHttpTransportExecutor(deferred.fetch);
		const first = executor.invoke(request());
		await Promise.resolve();

		await expect(executor.invoke(request())).rejects.toThrow(
			"HTTP transport invocation failed",
		);
		expect(deferred.calls[0]?.request.signal.aborted).toBe(false);
		deferred.calls[0]?.resolve(new Response(null));
		await first;
	});

	test("late cancelled completion cannot remove a reused active ID", async () => {
		const finishes: Array<(response: Response) => void> = [];
		const executor = new WebHttpTransportExecutor(
			() =>
				new Promise((resolve) => {
					finishes.push(resolve);
				}),
		);
		const first = executor.invoke(request());
		await Promise.resolve();
		executor.cancel("dispatch-1");
		const second = executor.invoke(request());
		await Promise.resolve();
		finishes[0]?.(new Response(null, { status: 204 }));

		expect(result(await first)).toEqual({ type: "cancelled" });
		await expect(executor.invoke(request())).rejects.toThrow(
			"HTTP transport invocation failed",
		);
		finishes[1]?.(new Response(null, { status: 204 }));
		expect(result(await second)).toMatchObject({
			type: "completed",
			status: 204,
		});
	});

	test("rejects malformed Rust JSON before fetch without reflecting input", async () => {
		let calls = 0;
		const executor = new WebHttpTransportExecutor(async () => {
			calls += 1;
			return new Response(null);
		});

		await expect(
			executor.invoke('{"dispatchId":"PRIVATE_VALUE"}'),
		).rejects.toThrow("HTTP transport invocation failed");
		expect(calls).toBe(0);
	});

	test("rejects Request construction failures as a redacted seam error", async () => {
		let calls = 0;
		const executor = new WebHttpTransportExecutor(async () => {
			calls += 1;
			return new Response(null);
		});

		const invocation = executor.invoke(
			request({
				headers: [{ name: "x-invalid", value: "PRIVATE\r\nINJECTION" }],
			}),
		);
		await expect(invocation).rejects.toThrow(
			"HTTP transport invocation failed",
		);
		await expect(invocation).rejects.not.toThrow("PRIVATE");
		expect(calls).toBe(0);
	});
});
