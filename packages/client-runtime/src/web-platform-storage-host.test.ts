import { describe, expect, test } from "bun:test";
import { WebPlatformStorageHost } from "./web-platform-storage-host";

class StorageDouble implements Storage {
	readonly values = new Map<string, string>();
	throwOn: "get" | "set" | "delete" | null = null;

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		if (this.throwOn === "get") throw new Error("get failed");
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		if (this.throwOn === "delete") throw new Error("delete failed");
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		if (this.throwOn === "set") throw new Error("set failed");
		this.values.set(key, value);
	}
}

function request(value: unknown): string {
	return JSON.stringify(value);
}

describe("Web platform storage host", () => {
	test("guarded deletion preserves changed bytes and reconciles exact and absent values", async () => {
		for (const area of [
			"devicePlain",
			"deviceSecret",
			"sessionSecret",
		] as const) {
			const storage = new StorageDouble();
			const host = new WebPlatformStorageHost({
				device: storage,
				session: storage,
			});
			const key = "owned:exact:%_\u0000";
			const expectedValue = '{"token":"original"}';
			storage.setItem(key, expectedValue);
			const earlier = await host.invoke(request({ type: "get", area, key }));
			expect(JSON.parse(earlier).value).toBe(expectedValue);
			storage.setItem(key, '{"token":"changed"}');
			storage.setItem(`${key}:near`, "unrelated");
			const deletion = request({
				type: "deleteIfUnchanged",
				area,
				key,
				expectedValue,
			});
			expect(JSON.parse(await host.invoke(deletion))).toEqual({
				type: "deleteResult",
				result: "conflict",
			});
			expect(storage.getItem(key)).toBe('{"token":"changed"}');
			storage.setItem(key, expectedValue);
			storage.throwOn = "delete";
			await expect(host.invoke(deletion)).rejects.toThrow();
			expect(storage.getItem(key)).toBe(expectedValue);
			storage.throwOn = null;
			expect(JSON.parse(await host.invoke(deletion))).toEqual({
				type: "deleteResult",
				result: "deleted",
			});
			expect(JSON.parse(await host.invoke(deletion))).toEqual({
				type: "deleteResult",
				result: "alreadyAbsent",
			});
			expect(storage.getItem(`${key}:near`)).toBe("unrelated");
		}
	});

	test("prefix deletion never removes its exact preserved marker, including shared areas and failures", async () => {
		const prefix = "owned:%_\0:";
		const marker = `${prefix}catalog`;
		class MarkerStorage extends StorageDouble {
			override removeItem(key: string): void {
				expect(key).not.toBe(marker);
				super.removeItem(key);
			}
		}
		for (const area of [
			"devicePlain",
			"deviceSecret",
			"sessionSecret",
		] as const) {
			const storage = new MarkerStorage();
			const host = new WebPlatformStorageHost({
				device: storage,
				session: storage,
			});
			storage.setItem(marker, "durable-reset");
			storage.setItem(`${prefix}account`, "staged");
			storage.setItem("unrelated", "preserved");
			const deletion = request({
				type: "deletePrefix",
				area,
				prefix,
				preserveKey: marker,
			});
			await expect(host.invoke(deletion)).resolves.toBe('{"type":"done"}');
			expect([...storage.values]).toEqual([
				[marker, "durable-reset"],
				["unrelated", "preserved"],
			]);
			storage.setItem(`${prefix}another`, "remaining");
			storage.throwOn = "delete";
			await expect(host.invoke(deletion)).rejects.toThrow();
			expect(storage.values.get(marker)).toBe("durable-reset");
			storage.throwOn = null;
			await host.invoke(deletion);
			expect(storage.values.has(`${prefix}another`)).toBe(false);
		}
	});

	test("lists literal prefix keys in UTF-8 order with the actual storage aliases", async () => {
		const prefix = "bittery:runtime:platform-storage:%_\0:";
		const first = `${prefix}\u{e000}`;
		const second = `${prefix}\u{10000}`;
		const near = "bittery:runtime:platform-storage:XY\0:near";
		for (const sharedSession of [false, true]) {
			const device = new StorageDouble();
			const session = sharedSession ? device : new StorageDouble();
			const host = new WebPlatformStorageHost({ device, session });
			for (const area of ["devicePlain", "sessionSecret"] as const) {
				for (const key of [second, near, first]) {
					await host.invoke(
						request({ type: "set", area, key, value: `retained-${area}` }),
					);
				}
			}
			const before = [new Map(device.values), new Map(session.values)];
			for (const area of [
				"devicePlain",
				"deviceSecret",
				"sessionSecret",
			] as const) {
				const response = await host.invoke(
					request({ type: "listKeys", area, prefix, cursor: null }),
				);
				expect(JSON.parse(response)).toEqual({
					type: "keysPage",
					version: 1,
					family: "platformStorage",
					backingAreas: sharedSession
						? ["devicePlain", "deviceSecret", "sessionSecret"]
						: area === "sessionSecret"
							? ["sessionSecret"]
							: ["devicePlain", "deviceSecret"],
					keys: [first, second],
					continuation: { type: "end" },
				});
				expect(response).not.toContain("retained-");
			}
			expect([device.values, session.values]).toEqual(before);
		}
	});

	test("pages by key and serialized byte bounds with cursors confined to their owner and scope", async () => {
		const prefix = "bittery:runtime:platform-storage:page:";
		for (const escapedKeys of [false, true]) {
			const storage = new StorageDouble();
			const host = new WebPlatformStorageHost({
				device: storage,
				session: storage,
			});
			const expected = Array.from(
				{ length: escapedKeys ? 50 : 130 },
				(_, index) =>
					`${prefix}${index.toString().padStart(3, "0")}${escapedKeys ? "\u0001".repeat(3900) : ""}`,
			);
			for (const key of [...expected].reverse()) {
				await host.invoke(
					request({ type: "set", area: "devicePlain", key, value: "retained" }),
				);
			}
			const before = new Map(storage.values);
			const initial = {
				type: "listKeys",
				area: "devicePlain",
				prefix,
				cursor: null,
			};
			const firstJson = await host.invoke(request(initial));
			const first = JSON.parse(firstJson);
			expect(first.continuation.type).toBe("more");
			if (escapedKeys) {
				expect(first.keys.length).toBeGreaterThan(0);
				expect(first.keys.length).toBeLessThan(128);
			} else {
				expect(first.keys.length).toBe(128);
			}
			const cursor: string = first.continuation.cursor;
			const resumed = { ...initial, cursor };
			const secondJson = await host.invoke(request(resumed));
			expect(await host.invoke(request(resumed))).toBe(secondJson);
			for (const invalid of [
				{ ...resumed, area: "deviceSecret" },
				{ ...resumed, prefix: `${prefix}other:` },
				{ ...resumed, cursor: `${cursor}!` },
			]) {
				await expect(host.invoke(request(invalid))).rejects.toThrow();
			}
			const reopened = new WebPlatformStorageHost({
				device: storage,
				session: storage,
			});
			await expect(reopened.invoke(request(resumed))).rejects.toThrow();
			expect(JSON.parse(await reopened.invoke(request(initial))).keys).toEqual(
				first.keys,
			);

			const all: string[] = [];
			let serialized = firstJson;
			let ended = false;
			for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
				expect(
					new TextEncoder().encode(serialized).byteLength,
				).toBeLessThanOrEqual(262144);
				const page = JSON.parse(serialized);
				expect(page.keys.length).toBeLessThanOrEqual(128);
				expect(page.keys.length).toBeGreaterThan(0);
				all.push(...page.keys);
				if (page.continuation.type === "end") {
					ended = true;
					break;
				}
				serialized = await host.invoke(
					request({ ...initial, cursor: page.continuation.cursor }),
				);
			}
			expect(ended).toBe(true);
			expect(all).toEqual(expected);
			expect(storage.values).toEqual(before);
		}
	});

	test("refuses malformed physical keys and null enumeration without altering storage", async () => {
		const prefix = "bittery:runtime:platform-storage:invalid:";
		const outcomes: Record<string, boolean> = {};
		for (const [name, key] of [
			["high surrogate", `${prefix}\ud800`],
			["low surrogate", `${prefix}\udfff`],
			["unrelated malformed key", "unrelated:\ud800"],
			["empty physical key", ""],
			["oversized UTF-8 key", `${prefix}${"😀".repeat(1024)}`],
			["null enumeration", `${prefix}retained`],
		] as const) {
			const storage = new StorageDouble();
			const host = new WebPlatformStorageHost({
				device: storage,
				session: storage,
			});
			await host.invoke(
				request({
					type: "set",
					area: "devicePlain",
					key,
					value: "retained-secret",
				}),
			);
			const before = new Map(storage.values);
			if (name === "null enumeration") storage.key = () => null;
			outcomes[name] = await host
				.invoke(
					request({
						type: "listKeys",
						area: "devicePlain",
						prefix,
						cursor: null,
					}),
				)
				.then(
					() => false,
					(error: unknown) => {
						expect(error).toBeInstanceOf(Error);
						expect((error as Error).message).not.toContain("retained-secret");
						return true;
					},
				);
			expect(storage.values).toEqual(before);
		}
		expect(outcomes).toEqual({
			"high surrogate": true,
			"low surrogate": true,
			"unrelated malformed key": true,
			"empty physical key": true,
			"oversized UTF-8 key": true,
			"null enumeration": true,
		});
	});

	test("deletes only keys under the requested prefix", async () => {
		const device = new StorageDouble();
		device.values.set("runtime:account:3:abc:one", "secret-one");
		device.values.set("runtime:account:3:abc:two", "secret-two");
		device.values.set("runtime:account:4:abcd:one", "kept");
		device.values.set("unrelated-host-key", "kept");
		const host = new WebPlatformStorageHost({
			device,
			session: new StorageDouble(),
		});

		expect(
			JSON.parse(
				await host.invoke(
					request({
						type: "deletePrefix",
						area: "deviceSecret",
						prefix: "runtime:account:3:abc:",
					}),
				),
			),
		).toEqual({ type: "done" });
		expect(device.values).toEqual(
			new Map([
				["runtime:account:4:abcd:one", "kept"],
				["unrelated-host-key", "kept"],
			]),
		);
		expect(
			JSON.parse(
				await host.invoke(
					request({
						type: "deletePrefix",
						area: "deviceSecret",
						prefix: "runtime:account:3:abc:",
					}),
				),
			),
		).toEqual({ type: "done" });
	});
	test("maps both device areas to localStorage and session secrets to sessionStorage", async () => {
		const device = new StorageDouble();
		const session = new StorageDouble();
		const host = new WebPlatformStorageHost({ device, session });

		for (const area of ["devicePlain", "deviceSecret"] as const) {
			expect(
				JSON.parse(
					await host.invoke(
						request({ type: "set", area, key: `key-${area}`, value: area }),
					),
				),
			).toEqual({ type: "done" });
		}
		await host.invoke(
			request({
				type: "set",
				area: "sessionSecret",
				key: "session-key",
				value: "session-value",
			}),
		);

		expect(device.values).toEqual(
			new Map([
				["key-devicePlain", "devicePlain"],
				["key-deviceSecret", "deviceSecret"],
			]),
		);
		expect(session.values).toEqual(new Map([["session-key", "session-value"]]));
	});

	test("gets missing as null and deletes an absent value idempotently", async () => {
		const host = new WebPlatformStorageHost({
			device: new StorageDouble(),
			session: new StorageDouble(),
		});

		expect(
			JSON.parse(
				await host.invoke(
					request({ type: "get", area: "devicePlain", key: "missing" }),
				),
			),
		).toEqual({ type: "value", value: null });
		expect(
			JSON.parse(
				await host.invoke(
					request({ type: "delete", area: "devicePlain", key: "missing" }),
				),
			),
		).toEqual({ type: "done" });
	});

	test("rejects malformed JSON, unknown areas, and unknown fields", async () => {
		const host = new WebPlatformStorageHost({
			device: new StorageDouble(),
			session: new StorageDouble(),
		});

		for (const invalid of [
			"not-json",
			request({ type: "get", area: "memory", key: "key" }),
			request({ type: "deletePrefix", area: "devicePlain" }),
			request({ type: "deletePrefix", area: "devicePlain", prefix: "" }),
			request({
				type: "deletePrefix",
				area: "devicePlain",
				prefix: "runtime:",
				key: "must-not-be-accepted",
			}),
			request({
				type: "get",
				area: "devicePlain",
				key: "key",
				unexpected: true,
			}),
		]) {
			await expect(host.invoke(invalid)).rejects.toThrow(
				/platform storage request/i,
			);
		}
	});

	test("normalizes browser storage failures without leaking host error details", async () => {
		for (const operation of ["get", "set", "delete", "deletePrefix"] as const) {
			const device = new StorageDouble();
			device.throwOn = operation === "deletePrefix" ? "delete" : operation;
			if (operation === "deletePrefix") {
				device.values.set("secret-prefix:key", "secret-value");
			}
			const host = new WebPlatformStorageHost({
				device,
				session: new StorageDouble(),
			});
			const envelope =
				operation === "set"
					? {
							type: operation,
							area: "devicePlain",
							key: "key",
							value: "value",
						}
					: operation === "deletePrefix"
						? {
								type: operation,
								area: "devicePlain",
								prefix: "secret-prefix:",
							}
						: { type: operation, area: "devicePlain", key: "key" };

			try {
				await host.invoke(request(envelope));
				throw new Error("expected the platform storage operation to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe(
					"Browser platform storage operation failed.",
				);
				expect((error as Error & { code?: string }).code).toBe(
					"platform-storage-failure",
				);
				expect((error as Error).message).not.toContain(`${operation} failed`);
				expect((error as Error).message).not.toContain("secret-prefix");
			}
		}
	});
});
