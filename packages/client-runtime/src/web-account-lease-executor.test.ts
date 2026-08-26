import { describe, expect, test } from "bun:test";
import { WebAccountLeaseExecutor } from "./web-account-lease-executor";

describe("Web Account lease executor", () => {
	test("exposes only Account acquisition and returns the closed denied result", async () => {
		const requests: Array<{
			name: string;
			options: LockOptions;
		}> = [];
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request(
					name: string,
					options: LockOptions,
					callback: (lock: Lock | null) => unknown,
				) {
					requests.push({ name, options });
					return Promise.resolve(callback(null));
				},
			},
		});

		const executor = new WebAccountLeaseExecutor();
		expect(Reflect.ownKeys(executor)).toEqual(["acquire"]);
		expect(await executor.acquire("account-a")).toBeNull();
		expect(requests).toEqual([
			{
				name: "bittery:attachment-move:account:account-a",
				options: { ifAvailable: true, mode: "exclusive" },
			},
		]);
	});

	test("holds the browser lock until one release and closes the exact handle", async () => {
		let requestSettled = false;
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				async request(
					_name: string,
					_options: LockOptions,
					callback: (lock: Lock | null) => unknown,
				) {
					await callback({ name: "held", mode: "exclusive" });
					requestSettled = true;
				},
			},
		});

		const handle = await new WebAccountLeaseExecutor().acquire("account-held");
		expect(handle).not.toBeNull();
		expect(Reflect.ownKeys(handle ?? {})).toEqual([
			"isLive",
			"lost",
			"release",
		]);
		expect(handle?.isLive()).toBe(true);
		expect(requestSettled).toBe(false);

		handle?.release();
		handle?.release();
		await handle?.lost();
		expect(handle?.isLive()).toBe(false);
		expect(requestSettled).toBe(true);
	});

	test("rejects acquisition when Web Locks rejects before granting", async () => {
		const failure = new DOMException("locks unavailable", "InvalidStateError");
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request() {
					return Promise.reject(failure);
				},
			},
		});

		await expect(
			new WebAccountLeaseExecutor().acquire("account-rejected"),
		).rejects.toBe(failure);
	});

	test("reports loss when Web Locks rejects after granting", async () => {
		let rejectRequest!: (error: unknown) => void;
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request(
					_name: string,
					_options: LockOptions,
					callback: (lock: Lock | null) => unknown,
				) {
					void callback({ name: "held", mode: "exclusive" });
					return new Promise<void>((_resolve, reject) => {
						rejectRequest = reject;
					});
				},
			},
		});

		const handle = await new WebAccountLeaseExecutor().acquire("account-lost");
		expect(handle?.isLive()).toBe(true);
		rejectRequest(new DOMException("context lost", "AbortError"));
		await handle?.lost();
		expect(handle?.isLive()).toBe(false);
		handle?.release();
	});
});
