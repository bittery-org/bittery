import { describe, expect, test } from "bun:test";
import { acquireStorageFamilyLease } from "./web-storage-maintenance";

function locks() {
	const held = new Set<string>();
	const calls: string[] = [];
	return {
		calls,
		manager: {
			async request(
				name: string,
				options: LockOptions,
				callback: (lock: Lock | null) => Promise<void>,
			) {
				calls.push(name);
				const mode = options.mode ?? "exclusive";
				if (held.has("exclusive") || (mode === "exclusive" && held.size > 0))
					return callback(null);
				const token = mode === "exclusive" ? mode : crypto.randomUUID();
				held.add(token);
				try {
					await callback({ name, mode } as Lock);
				} finally {
					held.delete(token);
				}
			},
		} as Pick<LockManager, "request">,
	};
}

describe("browser storage family maintenance exclusion", () => {
	test("normal owners coexist; maintenance refuses until every owner releases", async () => {
		const fake = locks();
		const a = await acquireStorageFamilyLease(
			"normal",
			undefined,
			fake.manager,
		);
		const b = await acquireStorageFamilyLease(
			"normal",
			undefined,
			fake.manager,
		);
		await expect(
			acquireStorageFamilyLease("maintenance", undefined, fake.manager),
		).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "busy" });
		await a?.release();
		await expect(
			acquireStorageFamilyLease("maintenance", undefined, fake.manager),
		).rejects.toMatchObject({ reason: "busy" });
		await b?.release();
		const exclusive = await acquireStorageFamilyLease(
			"maintenance",
			undefined,
			fake.manager,
		);
		await expect(
			acquireStorageFamilyLease("normal", undefined, fake.manager),
		).rejects.toMatchObject({ reason: "busy" });
		await exclusive?.release();
		const reopened = await acquireStorageFamilyLease(
			"normal",
			undefined,
			fake.manager,
		);
		await reopened?.release();
		expect(new Set(fake.calls).size).toBe(1);
	});
	test("cancellation after grant releases before the caller can use the owner", async () => {
		const fake = locks();
		const cancellation = new AbortController();
		const pending = acquireStorageFamilyLease(
			"normal",
			cancellation.signal,
			fake.manager,
		);
		cancellation.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const next = await acquireStorageFamilyLease(
			"maintenance",
			undefined,
			fake.manager,
		);
		await next?.release();
	});
	test("pre-cancelled admission never calls the browser", async () => {
		const fake = locks();
		const cancellation = new AbortController();
		cancellation.abort();
		await expect(
			acquireStorageFamilyLease("normal", cancellation.signal, fake.manager),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fake.calls).toHaveLength(0);
	});
	test("unsupported maintenance leaves ordinary IndexedDB admission available", async () => {
		expect(
			await acquireStorageFamilyLease("normal", undefined, null),
		).toBeUndefined();
		await expect(
			acquireStorageFamilyLease("maintenance", undefined, null),
		).rejects.toMatchObject({ reason: "unsupported" });
	});
	test("supported API failure never admits an unfenced normal owner", async () => {
		const manager = {
			request: () => Promise.reject(new Error("denied")),
		} as Pick<LockManager, "request">;
		await expect(
			acquireStorageFamilyLease("normal", undefined, manager),
		).rejects.toMatchObject({ reason: "unavailable" });
	});
	test("cancelled acquisition releases a late grant before reporting cancellation", async () => {
		let callback!: (lock: Lock | null) => Promise<void>;
		const manager = {
			request: (_name: string, _options: LockOptions, next: typeof callback) =>
				new Promise<void>((resolve) => {
					callback = async (lock) => {
						await next(lock);
						resolve();
					};
				}),
		} as Pick<LockManager, "request">;
		const cancellation = new AbortController();
		const pending = acquireStorageFamilyLease(
			"normal",
			cancellation.signal,
			manager,
		);
		cancellation.abort();
		await callback({ name: "ignored", mode: "shared" } as Lock);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});
