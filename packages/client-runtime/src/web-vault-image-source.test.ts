import { describe, expect, test } from "bun:test";
import {
	activateWebVaultImageSourceRegistry,
	MAX_VAULT_IMAGE_SOURCE_IDENTITIES,
	replaceFailedOpenVaultImageSourceRegistry,
	WebVaultImageSourceRegistry,
} from "./web-vault-image-source";

const source = (bytes = new Uint8Array([1])) => ({
	read: async (maximum: number) =>
		bytes.length <= maximum ? bytes : bytes.slice(0, maximum),
	close: async () => {},
});
const claim = (capabilityId: string, overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: "claim",
		capabilityId,
		accountId: "account-a",
		operationId: "operation-a",
		vaultId: "vault-a",
		contentType: "image/png",
		byteLength: "1",
		...overrides,
	});

describe("Web Vault-image source registry", () => {
	test("binds a single-use claim to the actual incarnation and exact request", async () => {
		const registry = new WebVaultImageSourceRegistry({
			identity: () => "cap-a",
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		const capabilityId = registry.grant({
			accountId: "account-a",
			operationId: "operation-a",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: source(),
		});
		expect((await registry.invoke(claim(capabilityId), "runtime-b")).type).toBe(
			"sourceFailure",
		);
		expect(
			(
				await registry.invoke(
					claim(capabilityId, { vaultId: "vault-b" }),
					"runtime-a",
				)
			).type,
		).toBe("sourceFailure");
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"claimed",
		);
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"sourceFailure",
		);
	});

	test("retains replay and expiry tombstones and retries failed cleanup", async () => {
		let now = 1_000;
		let closes = 0;
		const registry = new WebVaultImageSourceRegistry({
			now: () => now,
			identity: () => "cap-a",
			defaultLifetimeMs: 1,
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		const capabilityId = registry.grant({
			accountId: "account-a",
			operationId: "operation-a",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: {
				read: async () => null,
				close: async () => {
					closes += 1;
					if (closes === 1) throw new Error("retry");
				},
			},
		});
		now += 1;
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"sourceFailure",
		);
		expect(
			(
				await registry.invoke(
					JSON.stringify({ type: "close", capabilityId }),
					"runtime-a",
				)
			).type,
		).toBe("closed");
		expect(closes).toBe(2);
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"sourceFailure",
		);
	});

	test("uses one inclusive 1024 identity budget", async () => {
		let next = 0;
		const registry = new WebVaultImageSourceRegistry({
			identity: () => `cap-${next++}`,
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		for (
			let index = 0;
			index < MAX_VAULT_IMAGE_SOURCE_IDENTITIES - 2;
			index += 1
		)
			registry.grant({
				accountId: "account-a",
				operationId: `operation-${index}`,
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			});
		expect(() =>
			registry.grant({
				accountId: "account-a",
				operationId: "overflow",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			}),
		).toThrow();
	});

	test("admits exactly 1024 in-flight source controls", async () => {
		let release!: () => void;
		const held = new Promise<null>((resolve) => {
			release = () => resolve(null);
		});
		const registry = new WebVaultImageSourceRegistry({
			identity: () => "cap-in-flight",
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		const capabilityId = registry.grant({
			accountId: "account-a",
			operationId: "operation-a",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => held, close: async () => release() },
		});
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"claimed",
		);
		const request = JSON.stringify({
			type: "read",
			capabilityId,
			maxBytes: 1,
		});
		const admitted = Array.from(
			{ length: MAX_VAULT_IMAGE_SOURCE_IDENTITIES },
			() => registry.invoke(request, "runtime-a"),
		);
		await expect(registry.invoke(request, "runtime-a")).rejects.toThrow(
			"in-flight capacity",
		);
		release();
		expect(
			(await Promise.all(admitted)).every(({ type }) => type === "end"),
		).toBe(true);
	});

	test("retirement fences acceptance and waits for source cleanup", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = new WebVaultImageSourceRegistry({
			identity: () => "cap-a",
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		const capabilityId = registry.grant({
			accountId: "account-a",
			operationId: "operation-a",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => held },
		});
		const retirement = registry.retireAccount("runtime-a", "account-a");
		await Promise.resolve();
		expect(
			registry.admitAcceptance("runtime-a", "account-a", "operation-a"),
		).toBe(false);
		let retired = false;
		void retirement.then(() => {
			retired = true;
		});
		await Promise.resolve();
		expect(retired).toBe(false);
		release();
		await retirement;
		expect((await registry.invoke(claim(capabilityId), "runtime-a")).type).toBe(
			"sourceFailure",
		);
	});

	test("acceptance and every retirement authority share one race-free fence", async () => {
		for (const authority of [
			"lock",
			"signOut",
			"remove",
			"wipe",
			"close",
			"failedOpen",
			"accountRetirement",
			"incarnationRetirement",
		] as const) {
			const registry = new WebVaultImageSourceRegistry({
				identity: () => "cap-a",
			});
			await activateWebVaultImageSourceRegistry(registry, "runtime-a");
			const capabilityId = registry.grant({
				accountId: "account-a",
				operationId: "operation-a",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			});
			expect(
				(await registry.invoke(claim(capabilityId), "runtime-a")).type,
			).toBe("claimed");
			expect(
				(
					await registry.invoke(
						JSON.stringify({ type: "close", capabilityId }),
						"runtime-a",
					)
				).type,
			).toBe("closed");
			const release = registry.beginAcceptance(
				"runtime-a",
				"account-a",
				"operation-a",
			);
			expect(release).toBeFunction();
			let retired = false;
			const task =
				authority === "wipe" || authority === "incarnationRetirement"
					? registry.retireRuntime("runtime-a")
					: authority === "close" || authority === "failedOpen"
						? registry.drainClose()
						: registry.retireAccount("runtime-a", "account-a");
			void task.then(() => {
				retired = true;
			});
			await Promise.resolve();
			expect(retired).toBe(false);
			release?.();
			await task;
			expect(retired).toBe(true);
		}
	});

	test("Runtime source controls acquire and release the same retirement fence", async () => {
		for (const authority of ["account", "runtime", "close"] as const) {
			const registry = new WebVaultImageSourceRegistry({
				identity: () => "cap-a",
			});
			await activateWebVaultImageSourceRegistry(registry, "runtime-a");
			const capabilityId = registry.grant({
				accountId: "account-a",
				operationId: "operation-a",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			});
			expect(
				(await registry.invoke(claim(capabilityId), "runtime-a")).type,
			).toBe("claimed");
			expect(
				(
					await registry.invoke(
						JSON.stringify({ type: "close", capabilityId }),
						"runtime-a",
					)
				).type,
			).toBe("closed");
			expect(
				(
					await registry.invoke(
						JSON.stringify({
							type: "beginAcceptance",
							accountId: "account-a",
							operationId: "operation-a",
						}),
						"runtime-a",
					)
				).type,
			).toBe("acceptanceBegun");
			let retired = false;
			const retirement = (
				authority === "account"
					? registry.retireAccount("runtime-a", "account-a")
					: authority === "runtime"
						? registry.retireRuntime("runtime-a")
						: registry.drainClose()
			).then(() => {
				retired = true;
			});
			await Promise.resolve();
			expect(retired).toBe(false);
			expect(
				(
					await registry.invoke(
						JSON.stringify({
							type: "endAcceptance",
							accountId: "account-a",
							operationId: "operation-a",
						}),
						"runtime-a",
					)
				).type,
			).toBe("acceptanceEnded");
			await retirement;
			expect(retired).toBe(true);
		}
	});

	test("failed-open recovery drains the old registry before constructing one fresh bounded registry", async () => {
		let closes = 0;
		const old = new WebVaultImageSourceRegistry({ identity: () => "cap-old" });
		await activateWebVaultImageSourceRegistry(old, "runtime-old");
		old.grant({
			accountId: "account-a",
			operationId: "operation-a",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: {
				read: async () => null,
				close: async () => {
					closes += 1;
					if (closes === 1) throw new Error("cleanup");
				},
			},
		});
		await expect(
			replaceFailedOpenVaultImageSourceRegistry(old, {
				identity: () => "cap-new",
			}),
		).rejects.toThrow();
		const fresh = await replaceFailedOpenVaultImageSourceRegistry(old, {
			identity: () => "cap-new",
		});
		expect(closes).toBe(2);
		await activateWebVaultImageSourceRegistry(fresh, "runtime-new");
		expect(
			fresh.grant({
				accountId: "account-a",
				operationId: "operation-new",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			}),
		).toBe("cap-new");
	});

	test("every retirement authority cancels a held read before it waits for cleanup", async () => {
		for (const authority of [
			"lock",
			"signOut",
			"remove",
			"wipe",
			"close",
			"failedOpen",
			"accountRetirement",
			"incarnationRetirement",
		] as const) {
			let releaseRead!: () => void;
			let closeCalls = 0;
			const heldRead = new Promise<Uint8Array | null>((resolve) => {
				releaseRead = () => resolve(null);
			});
			const registry = new WebVaultImageSourceRegistry({
				identity: () => `cap-${authority}`,
			});
			await activateWebVaultImageSourceRegistry(registry, "runtime-a");
			const capabilityId = registry.grant({
				accountId: "account-a",
				operationId: "operation-a",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: {
					read: async () => heldRead,
					close: async () => {
						closeCalls += 1;
						releaseRead();
					},
				},
			});
			expect(
				(await registry.invoke(claim(capabilityId), "runtime-a")).type,
			).toBe("claimed");
			const read = registry.invoke(
				JSON.stringify({ type: "read", capabilityId, maxBytes: 1 }),
				"runtime-a",
			);
			await Promise.resolve();
			const retirement =
				authority === "wipe" || authority === "incarnationRetirement"
					? registry.retireRuntime("runtime-a")
					: authority === "close" || authority === "failedOpen"
						? registry.drainClose()
						: registry.retireAccount("runtime-a", "account-a");
			await retirement;
			expect(closeCalls).toBe(1);
			expect((await read).type).toBe("cancelled");
		}
	});

	test("a completed Lock or Sign-out retirement permits a new Account generation", async () => {
		let next = 0;
		const registry = new WebVaultImageSourceRegistry({
			identity: () => `cap-${next++}`,
		});
		await activateWebVaultImageSourceRegistry(registry, "runtime-a");
		for (const authority of ["lock", "signOut"] as const) {
			registry.grant({
				accountId: "account-a",
				operationId: `operation-${authority}`,
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			});
			await registry.retireAccount("runtime-a", "account-a");
			registry.reactivateAccount("runtime-a", "account-a");
		}
		expect(
			registry.grant({
				accountId: "account-a",
				operationId: "operation-reactivated",
				vaultId: "vault-a",
				contentType: "image/png",
				byteLength: 1n,
				source: source(),
			}),
		).toBe("cap-2");
	});
});
