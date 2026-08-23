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

	test("propagates browser storage failures without fabricating success", async () => {
		for (const operation of ["get", "set", "delete"] as const) {
			const device = new StorageDouble();
			device.throwOn = operation;
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
					: { type: operation, area: "devicePlain", key: "key" };

			await expect(host.invoke(request(envelope))).rejects.toThrow(
				`${operation} failed`,
			);
		}
	});
});
