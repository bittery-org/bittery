import { expect, test } from "bun:test";
import { WebHttpTransportExecutor } from "./web-http-transport-executor";

const open = (dispatchId = "stream-1", maxResponseBytes = 4) =>
	JSON.stringify({
		type: "openStream",
		request: {
			dispatchId,
			method: "GET",
			url: "https://api.example.test/events",
			headers: [
				{ name: "Authorization", value: "Bearer exact" },
				{ name: "Accept", value: "text/event-stream" },
			],
			body: [],
			maxResponseBytes,
		},
	});
const read = (dispatchId = "stream-1") =>
	JSON.stringify({ type: "readStream", dispatchId });

function controlled() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancellations = 0;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
		cancel() {
			cancellations += 1;
		},
	});
	const requests: Request[] = [];
	const executor = new WebHttpTransportExecutor(async (request) => {
		requests.push(request as Request);
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { executor, controller, requests, cancellations: () => cancellations };
}

test("stream opens before body ends, pulls exact bounded bytes, and retires on EOF", async () => {
	const { executor, controller, requests } = controlled();
	expect(JSON.parse(await executor.invoke(open()))).toEqual({
		type: "opened",
		status: 200,
		headers: [{ name: "content-type", value: "text/event-stream" }],
	});
	expect(requests[0]?.headers.get("authorization")).toBe("Bearer exact");
	expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
	expect(requests[0]?.redirect).toBe("manual");
	controller.enqueue(new Uint8Array([13, 10, 0, 255]));
	expect(JSON.parse(await executor.invoke(read()))).toEqual({
		type: "chunk",
		bytes: [13, 10, 0, 255],
	});
	controller.close();
	expect(JSON.parse(await executor.invoke(read()))).toEqual({ type: "ended" });
	expect(requests[0]?.signal.aborted).toBe(true);
	expect(JSON.parse(await executor.invoke(read()))).toEqual({
		type: "cancelled",
	});
});

test("cancellation resolves a held read and does not retire another Account stream", async () => {
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const requests: Request[] = [];
	const executor = new WebHttpTransportExecutor(async (request) => {
		requests.push(request as Request);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controllers.push(controller);
				},
			}),
		);
	});
	await executor.invoke(open("account-a"));
	await executor.invoke(open("account-b"));
	const first = executor.invoke(read("account-a"));
	const second = executor.invoke(read("account-b"));
	executor.cancel("account-a");
	expect(JSON.parse(await first)).toEqual({ type: "cancelled" });
	expect(requests[0]?.signal.aborted).toBe(true);
	expect(requests[1]?.signal.aborted).toBe(false);
	controllers[1]?.enqueue(new Uint8Array([2]));
	expect(JSON.parse(await second)).toEqual({ type: "chunk", bytes: [2] });
	controllers[1]?.enqueue(new Uint8Array([3]));
	expect(JSON.parse(await executor.invoke(read("account-b")))).toEqual({
		type: "chunk",
		bytes: [3],
	});
	executor.cancel("account-b");
});

test("oversized chunks close their bounded stream instead of buffering it", async () => {
	const { executor, controller, requests, cancellations } = controlled();
	await executor.invoke(open());
	controller.enqueue(new Uint8Array(5));
	expect(JSON.parse(await executor.invoke(read()))).toEqual({
		type: "responseTooLarge",
	});
	expect(requests[0]?.signal.aborted).toBe(true);
	expect(cancellations()).toBe(1);
});

test("read failure is redacted and permanently retires the stream", async () => {
	const { executor, controller, requests } = controlled();
	await executor.invoke(open());
	const pending = executor.invoke(read());
	controller.error(new Error("PRIVATE_NETWORK_DETAIL"));
	expect(JSON.parse(await pending)).toEqual({ type: "networkFailure" });
	expect(requests[0]?.signal.aborted).toBe(true);
	expect(JSON.parse(await executor.invoke(read()))).toEqual({
		type: "cancelled",
	});
});

test("a stream refuses overlapping reads and duplicate open identities", async () => {
	const { executor, controller } = controlled();
	await executor.invoke(open());
	await expect(executor.invoke(open())).rejects.toThrow(
		"HTTP transport invocation failed",
	);
	const pending = executor.invoke(read());
	await expect(executor.invoke(read())).rejects.toThrow(
		"HTTP transport invocation failed",
	);
	controller.enqueue(new Uint8Array([1]));
	expect(JSON.parse(await pending)).toEqual({ type: "chunk", bytes: [1] });
	executor.cancel("stream-1");
});

test("cancelled opening retires a late response and cannot erase a replacement stream", async () => {
	const answers: Array<(response: Response) => void> = [];
	const executor = new WebHttpTransportExecutor(
		() => new Promise((resolve) => answers.push(resolve)),
	);
	const opening = executor.invoke(open());
	await Promise.resolve();
	executor.cancel("stream-1");
	const replacement = executor.invoke(open());
	await Promise.resolve();
	answers[0]?.(new Response("late"));
	expect(JSON.parse(await opening)).toEqual({ type: "cancelled" });
	answers[1]?.(new Response("ok"));
	expect(JSON.parse(await replacement)).toMatchObject({
		type: "opened",
		status: 200,
	});
	expect(JSON.parse(await executor.invoke(read()))).toEqual({
		type: "chunk",
		bytes: [111, 107],
	});
	executor.cancel("stream-1");
});

test("finite and stream dispatches reserve their shared identity before awaiting host preparation", async () => {
	for (const streamingFirst of [false, true]) {
		const requests: Request[] = [];
		const executor = new WebHttpTransportExecutor(async (request) => {
			requests.push(request as Request);
			return new Response(
				new ReadableStream({
					start(controller) {
						(request as Request).signal.addEventListener(
							"abort",
							() => controller.close(),
							{ once: true },
						);
					},
				}),
			);
		});
		const finite = JSON.stringify(JSON.parse(open()).request);
		const first = executor.invoke(streamingFirst ? open() : finite);
		await expect(
			executor.invoke(streamingFirst ? finite : open()),
		).rejects.toThrow("HTTP transport invocation failed");
		await Promise.resolve();
		expect(requests).toHaveLength(1);
		executor.cancel("stream-1");
		expect(requests[0]?.signal.aborted).toBe(true);
		await first;
	}
});
