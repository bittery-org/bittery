import { describe, expect, test } from "bun:test";
import {
	commitWebAttachmentUploadRuntimeIncarnation,
	MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES,
	prepareWebAttachmentUploadRuntimeIncarnation,
	WebAttachmentUploadSourceRegistry,
} from "./web-attachment-upload-source";

async function activate(
	registry: WebAttachmentUploadSourceRegistry,
	incarnation = "runtime-a",
) {
	await prepareWebAttachmentUploadRuntimeIncarnation(registry, incarnation);
	await commitWebAttachmentUploadRuntimeIncarnation(registry, incarnation);
}

function hostilePlaintext(values: number[]) {
	const bytes = new Uint8Array(values);
	let getterCalls = 0;
	for (const key of [
		"buffer",
		"byteOffset",
		"byteLength",
		"length",
		Symbol.iterator,
		"custom",
	] as const) {
		Object.defineProperty(bytes, key, {
			configurable: true,
			get: () => {
				getterCalls += 1;
				throw new Error("hostile binary accessor");
			},
		});
	}
	return { bytes, getterCalls: () => getterCalls };
}

describe("WebAttachmentUploadSourceRegistry", () => {
	test("full capacity still fences and drains an already selected Vault", async () => {
		let next = 0;
		let closed = 0;
		const registry = new WebAttachmentUploadSourceRegistry({
			identity: () => `capacity-${next++}`,
		});
		await activate(registry);
		const scope = registry.captureScope("account-a", "vault-a");
		let accepted = 0;
		for (;;) {
			try {
				registry.grant({
					scope,
					accountId: "account-a",
					vaultId: "vault-a",
					itemId: "item",
					name: "a",
					contentType: "text/plain",
					expectedBytes: 1n,
					source: {
						read: async () => null,
						close: async () => {
							closed++;
						},
					},
				});
				accepted++;
			} catch {
				break;
			}
		}
		expect(accepted).toBeGreaterThan(1000);
		const result = await registry.invoke(
			JSON.stringify({
				type: "retireVaults",
				accountId: "account-a",
				vaultIds: ["vault-a"],
			}),
			"runtime-a",
		);
		expect(JSON.parse(result.controlResponseJson)).toEqual({ type: "retired" });
		expect(closed).toBe(accepted);
		expect(() => registry.captureScope("account-a", "vault-a")).toThrow();
	});
	test("caller release wipes a pending source read before cleanup completes", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		let resolveRead!: (value: Uint8Array) => void;
		let started!: () => void;
		const ready = new Promise<void>((r) => (started = r));
		const bytes = new Uint8Array([71]);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account", "vault"),
			accountId: "account",
			vaultId: "vault",
			itemId: "item",
			name: "x",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => {
					started();
					return new Promise<Uint8Array>((r) => (resolveRead = r));
				},
				close: async () => {
					resolveRead(bytes);
				},
			},
		});
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				capabilityId,
				accountId: "account",
				vaultId: "vault",
				itemId: "item",
				name: "x",
				contentType: "text/plain",
				expectedBytes: "1",
			}),
			"runtime-a",
		);
		const reading = registry.invoke(
			JSON.stringify({ type: "read", capabilityId, maxBytes: 1 }),
			"runtime-a",
		);
		await ready;
		await registry.release(capabilityId);
		const result = await reading;
		expect(result.binaryChunk).toBeUndefined();
		expect([...bytes]).toEqual([0]);
		await registry.release(capabilityId);
	});
	test("retirement wipes a late plaintext read and permanently fences preselection scopes", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const scope = registry.captureScope("account-a", "vault-a");
		const bytes = new Uint8Array([42]);
		let finishRead!: (value: Uint8Array) => void;
		let beganRead!: () => void;
		const began = new Promise<void>((resolve) => {
			beganRead = resolve;
		});
		const source = {
			read: async () => {
				beganRead();
				return new Promise<Uint8Array>((resolve) => {
					finishRead = resolve;
				});
			},
			close: async () => {
				finishRead(bytes);
			},
		};
		const grant = {
			scope,
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "a",
			contentType: "text/plain",
			expectedBytes: 1n,
			source,
		};
		const capabilityId = registry.grant(grant);
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				capabilityId,
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "a",
				contentType: "text/plain",
				expectedBytes: "1",
			}),
			"runtime-a",
		);
		const read = registry.invoke(
			JSON.stringify({ type: "read", capabilityId, maxBytes: 1 }),
			"runtime-a",
		);
		await began;
		const retire = registry.invoke(
			JSON.stringify({
				type: "retireVaults",
				accountId: "account-a",
				vaultIds: ["vault-a"],
			}),
			"runtime-a",
		);
		expect(() => registry.grant(grant)).toThrow();
		expect(JSON.parse((await retire).controlResponseJson)).toEqual({
			type: "retired",
		});
		expect((await read).binaryChunk).toBeUndefined();
		expect([...bytes]).toEqual([0]);
		await registry.invoke(
			JSON.stringify({
				type: "completeVaultRetirement",
				accountId: "account-a",
				vaultIds: ["vault-a"],
			}),
			"runtime-a",
		);
		expect(() => registry.grant(grant)).toThrow();
		const replacement = registry.grant({
			...grant,
			scope: registry.captureScope("account-a", "vault-a"),
			source: { read: async () => null, close: async () => {} },
		});
		await registry.release(replacement);
		await registry.release(replacement);
	});
	test("Vault retirement closes only its sources, including an unused moved Item selection", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const closed: string[] = [];
		const grant = (accountId: string, vaultId: string) =>
			registry.grant({
				scope: registry.captureScope(accountId, vaultId),
				accountId,
				vaultId,
				itemId: "same-item",
				name: "a.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: {
					read: async () => new Uint8Array([9]),
					close: async () => {
						closed.push(`${accountId}/${vaultId}`);
					},
				},
			});
		grant("account-a", "hidden");
		const visible = grant("account-a", "visible");
		grant("account-b", "hidden");
		const retired = await registry.invoke(
			JSON.stringify({
				type: "retireVaults",
				accountId: "account-a",
				vaultIds: ["hidden"],
			}),
			"runtime-a",
		);
		expect(JSON.parse(retired.controlResponseJson)).toEqual({
			type: "retired",
		});
		expect(closed).toEqual(["account-a/hidden"]);
		expect(() => grant("account-a", "hidden")).toThrow();
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({
							type: "claim",
							capabilityId: visible,
							accountId: "account-a",
							vaultId: "visible",
							itemId: "same-item",
							name: "a.txt",
							contentType: "text/plain",
							expectedBytes: "1",
						}),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "claimed" });
		await registry.drainClose();
	});
	test("rejects every non-exact upload source control shape without leaking parser exceptions", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		for (const value of [
			null,
			[],
			"claim",
			{},
			{ type: "unknown" },
			{ type: "claim" },
			{
				type: "claim",
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "a.txt",
				contentType: "text/plain",
				capabilityId: "capability-a",
				expectedBytes: 1,
			},
			{ type: "read", capabilityId: "capability-a" },
			{ type: "read", capabilityId: "capability-a", maxBytes: "1" },
			{
				type: "close",
				capabilityId: "capability-a",
				extra: true,
			},
			{ type: "retireAccount" },
			{ type: "completeAccountRetirement", accountId: 1 },
			{ type: "retireRuntime", extra: true },
		]) {
			const response = await registry.invoke(
				JSON.stringify(value),
				"runtime-a",
			);
			expect(JSON.parse(response.controlResponseJson)).toEqual({
				type: "invariantViolation",
			});
		}
		const invalidJson = await registry.invoke("{", "runtime-a");
		expect(JSON.parse(invalidJson.controlResponseJson)).toEqual({
			type: "invariantViolation",
		});
	});

	test("binds one plaintext source to Account, Runtime, Item, request and wipes on close", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		let closed = 0;
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 3n,
			source: {
				read: async () => bytes,
				close: async () => {
					bytes.fill(0);
					closed++;
				},
			},
		});
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({
							type: "claim",
							accountId: "account-a",
							vaultId: "vault-a",
							itemId: "item-a",
							name: "report.txt",
							contentType: "text/plain",
							capabilityId,
							expectedBytes: "3",
						}),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "claimed" });
		const read = await registry.invoke(
			JSON.stringify({ type: "read", capabilityId, maxBytes: 4 }),
			"runtime-a",
		);
		expect(read.binaryChunk).toBe(bytes);
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({ type: "close", capabilityId }),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "closed" });
		expect(closed).toBe(1);
		expect([...bytes]).toEqual([0, 0, 0]);
	});

	test("wipes hostile actual Uint8Array results without invoking own accessors", async () => {
		const hostile = hostilePlaintext([7, 8, 9]);
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "hostile.txt",
			contentType: "text/plain",
			expectedBytes: 3n,
			source: { read: async () => hostile.bytes, close: async () => {} },
		});
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "hostile.txt",
				contentType: "text/plain",
				capabilityId,
				expectedBytes: "3",
			}),
			"runtime-a",
		);
		const result = await registry.invoke(
			JSON.stringify({ type: "read", capabilityId, maxBytes: 3 }),
			"runtime-a",
		);
		expect(JSON.parse(result.controlResponseJson)).toEqual({
			type: "invariantViolation",
		});
		expect(result.binaryChunk).toBeUndefined();
		expect(hostile.getterCalls()).toBe(0);
		expect(Uint8Array.prototype.slice.call(hostile.bytes)).toEqual(
			new Uint8Array(3),
		);
	});

	test("rejects a claim whose decrypted metadata differs from the granted UploadAttachment request", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: { read: async () => null, close: async () => {} },
		});
		for (const metadata of [
			{ name: "renamed.txt", contentType: "text/plain" },
			{ name: "report.txt", contentType: "application/pdf" },
		]) {
			expect(
				JSON.parse(
					(
						await registry.invoke(
							JSON.stringify({
								type: "claim",
								accountId: "account-a",
								vaultId: "vault-a",
								itemId: "item-a",
								...metadata,
								capabilityId,
								expectedBytes: "1",
							}),
							"runtime-a",
						)
					).controlResponseJson,
				),
			).toEqual({ type: "sourceFailure" });
		}
	});

	test("rejects replay and cross-incarnation claims", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: { read: async () => null, close: async () => {} },
		});
		const control = JSON.stringify({
			type: "claim",
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			capabilityId,
			expectedBytes: "1",
		});
		expect(
			JSON.parse(
				(await registry.invoke(control, "runtime-b")).controlResponseJson,
			),
		).toEqual({ type: "cancelled" });
		expect(
			JSON.parse(
				(await registry.invoke(control, "runtime-a")).controlResponseJson,
			),
		).toEqual({ type: "claimed" });
		expect(
			JSON.parse(
				(await registry.invoke(control, "runtime-a")).controlResponseJson,
			),
		).toEqual({ type: "sourceFailure" });
	});

	test("fences plaintext reads and drains the source during Runtime close", async () => {
		const bytes = new Uint8Array([9]);
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => bytes,
				close: async () => {
					bytes.fill(0);
				},
			},
		});
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "report.txt",
				contentType: "text/plain",
				capabilityId,
				expectedBytes: "1",
			}),
			"runtime-a",
		);
		registry.beginClose();
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({ type: "read", capabilityId, maxBytes: 1 }),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "cancelled" });
		await registry.drainClose();
		expect([...bytes]).toEqual([0]);
	});

	test("retains failed cleanup ownership until an identical close converges", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		let closes = 0;
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => null,
				close: async () => {
					closes += 1;
					if (closes === 1) throw new Error("transient");
				},
			},
		});
		const close = JSON.stringify({ type: "close", capabilityId });
		expect(
			JSON.parse(
				(await registry.invoke(close, "runtime-a")).controlResponseJson,
			),
		).toEqual({ type: "sourceFailure" });
		expect(
			JSON.parse(
				(await registry.invoke(close, "runtime-a")).controlResponseJson,
			),
		).toEqual({ type: "closed" });
		expect(closes).toBe(2);
	});

	test("retires a failed-open pending scope and admits a fresh reconstruction", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await prepareWebAttachmentUploadRuntimeIncarnation(registry, "failed-open");
		expect(
			JSON.parse(
				(await registry.invoke('{"type":"retireRuntime"}', "failed-open"))
					.controlResponseJson,
			),
		).toEqual({ type: "retired" });
		await activate(registry, "fresh-runtime");
		expect(
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toBeString();
	});

	test("beginClose stays terminal when it races the awaited half of Runtime retirement", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: { read: async () => null, close: async () => blocked },
		});
		const retirement = registry.invoke('{"type":"retireRuntime"}', "runtime-a");
		await Promise.resolve();
		registry.beginClose();
		release();
		expect(JSON.parse((await retirement).controlResponseJson)).toEqual({
			type: "retired",
		});
		await expect(
			prepareWebAttachmentUploadRuntimeIncarnation(registry, "after-close"),
		).rejects.toThrow();
		await registry.drainClose();
	});

	test("fences Account retirement through exact completion", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: { read: async () => null, close: async () => {} },
		});
		expect(
			JSON.parse(
				(
					await registry.invoke(
						'{"type":"retireAccount","accountId":"account-a"}',
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "retired" });
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow();
		await registry.invoke(
			'{"type":"completeAccountRetirement","accountId":"account-a"}',
			"runtime-a",
		);
		expect(
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toBeString();
	});

	test("rejects non-canonical Account retirement identities without retaining state or capacity", async () => {
		let next = 0;
		const registry = new WebAttachmentUploadSourceRegistry({
			identity: () => `cap-${next++}`,
		});
		await activate(registry);
		for (const accountId of ["", " account-a", "account/a", "a".repeat(129)]) {
			for (const type of [
				"retireAccount",
				"completeAccountRetirement",
			] as const) {
				expect(
					JSON.parse(
						(
							await registry.invoke(
								JSON.stringify({ type, accountId }),
								"runtime-a",
							)
						).controlResponseJson,
					),
				).toEqual({ type: "invariantViolation" });
			}
		}
		for (
			let index = 0;
			index < MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES - 3;
			index++
		) {
			registry.grant({
				scope: registry.captureScope("account-capacity", "vault-a"),
				accountId: "account-capacity",
				vaultId: "vault-a",
				itemId: `item-${index}`,
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			});
		}
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-capacity", "vault-a"),
				accountId: "account-capacity",
				vaultId: "vault-a",
				itemId: "overflow",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow("capacity");
	});

	test("fences a concurrent grant before Account cleanup yields and retries cleanup", async () => {
		const registry = new WebAttachmentUploadSourceRegistry();
		await activate(registry);
		let release!: () => void;
		let started!: () => void;
		const secondCleanupStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let attempts = 0;
		registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => null,
				close: async () => {
					attempts++;
					if (attempts === 1) throw new Error("cleanup failed");
					started();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				},
			},
		});
		const retire = registry.invoke(
			'{"type":"retireAccount","accountId":"account-a"}',
			"runtime-a",
		);
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-b",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow();
		expect(JSON.parse((await retire).controlResponseJson)).toEqual({
			type: "sourceFailure",
		});
		const retry = registry.invoke(
			'{"type":"retireAccount","accountId":"account-a"}',
			"runtime-a",
		);
		await secondCleanupStarted;
		release();
		expect(JSON.parse((await retry).controlResponseJson)).toEqual({
			type: "retired",
		});
	});

	test("expires untouched grants and includes tombstones in exact capacity", async () => {
		let now = 1;
		let next = 0;
		const registry = new WebAttachmentUploadSourceRegistry({
			now: () => now,
			identity: () => `cap-${next++}`,
		});
		await activate(registry);
		const expired = registry.grant({
			scope: registry.captureScope("account-expired", "vault-a"),
			accountId: "account-expired",
			vaultId: "vault-a",
			itemId: "item",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			expiresAt: 2,
			source: { read: async () => null, close: async () => {} },
		});
		now = 3;
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({
							type: "claim",
							accountId: "account-expired",
							vaultId: "vault-a",
							itemId: "item",
							name: "report.txt",
							contentType: "text/plain",
							capabilityId: expired,
							expectedBytes: "1",
						}),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "sourceFailure" });
		for (
			let index = 0;
			index < MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES - 6;
			index++
		) {
			registry.grant({
				scope: registry.captureScope("account-capacity", "vault-a"),
				accountId: "account-capacity",
				vaultId: "vault-a",
				itemId: `item-${index}`,
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			});
		}
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-capacity", "vault-a"),
				accountId: "account-capacity",
				vaultId: "vault-a",
				itemId: "overflow",
				name: "report.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow();
	});

	test("retains an expiry tombstone so its capability identity cannot be reused in the same Runtime incarnation", async () => {
		let now = 1;
		const registry = new WebAttachmentUploadSourceRegistry({
			now: () => now,
			identity: () => "expiring-capability",
		});
		await activate(registry);
		registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			expiresAt: 2,
			source: { read: async () => null, close: async () => {} },
		});
		now = 3;
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "report.txt",
				contentType: "text/plain",
				capabilityId: "expiring-capability",
				expectedBytes: "1",
			}),
			"runtime-a",
		);
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-b",
				name: "other.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow("identity");
	});

	test("retains an expiry tombstone when the clock crosses expiry between sweep and invocation", async () => {
		const samples = [0, 1, 1, 1, 3];
		const registry = new WebAttachmentUploadSourceRegistry({
			now: () => samples.shift() ?? 3,
			identity: () => "changing-clock-capability",
		});
		await activate(registry);
		registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			expiresAt: 2,
			source: { read: async () => null, close: async () => {} },
		});
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({
							type: "claim",
							accountId: "account-a",
							vaultId: "vault-a",
							itemId: "item-a",
							name: "report.txt",
							contentType: "text/plain",
							capabilityId: "changing-clock-capability",
							expectedBytes: "1",
						}),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "sourceFailure" });
		expect(() =>
			registry.grant({
				scope: registry.captureScope("account-a", "vault-a"),
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-b",
				name: "other.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).toThrow("identity");
	});

	test("close interrupts and drains a held source read before retiring the capability", async () => {
		let releaseRead = (_value: Uint8Array | null) => {};
		let markReadStarted = () => {};
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const registry = new WebAttachmentUploadSourceRegistry({
			identity: () => "held-read-capability",
		});
		await activate(registry);
		const capabilityId = registry.grant({
			scope: registry.captureScope("account-a", "vault-a"),
			accountId: "account-a",
			vaultId: "vault-a",
			itemId: "item-a",
			name: "held.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => {
					markReadStarted();
					return new Promise<Uint8Array | null>((resolve) => {
						releaseRead = resolve;
					});
				},
				close: async () => releaseRead(null),
			},
		});
		await registry.invoke(
			JSON.stringify({
				type: "claim",
				accountId: "account-a",
				vaultId: "vault-a",
				itemId: "item-a",
				name: "held.txt",
				contentType: "text/plain",
				capabilityId,
				expectedBytes: "1",
			}),
			"runtime-a",
		);
		const read = registry.invoke(
			JSON.stringify({ type: "read", capabilityId, maxBytes: 1 }),
			"runtime-a",
		);
		await readStarted;
		const closed = await registry.invoke(
			JSON.stringify({ type: "close", capabilityId }),
			"runtime-a",
		);
		expect(JSON.parse(closed.controlResponseJson)).toEqual({ type: "closed" });
		expect(JSON.parse((await read).controlResponseJson)).toEqual({
			type: "end",
		});
		expect(
			JSON.parse(
				(
					await registry.invoke(
						JSON.stringify({ type: "close", capabilityId }),
						"runtime-a",
					)
				).controlResponseJson,
			),
		).toEqual({ type: "closed" });
	});
});

test("startup Vault cleanup owns only the prepared Runtime and survives commit", async () => {
	const registry = new WebAttachmentUploadSourceRegistry();
	await prepareWebAttachmentUploadRuntimeIncarnation(registry, "startup");
	const retiring = JSON.stringify({
		type: "retireVaults",
		accountId: "account-a",
		vaultIds: ["hidden"],
	});
	expect(
		JSON.parse(
			(await registry.invoke(retiring, "foreign")).controlResponseJson,
		),
	).toEqual({ type: "invariantViolation" });
	expect(
		JSON.parse(
			(await registry.invoke(retiring, "startup")).controlResponseJson,
		),
	).toEqual({ type: "retired" });
	expect(() => registry.captureScope("account-a", "visible")).toThrow();
	await commitWebAttachmentUploadRuntimeIncarnation(registry, "startup");
	expect(() => registry.captureScope("account-a", "hidden")).toThrow();
	expect(() => registry.captureScope("account-a", "visible")).not.toThrow();
	expect(() => registry.captureScope("account-b", "hidden")).not.toThrow();
	expect(
		JSON.parse(
			(
				await registry.invoke(
					JSON.stringify({
						type: "completeVaultRetirement",
						accountId: "account-a",
						vaultIds: ["hidden"],
					}),
					"startup",
				)
			).controlResponseJson,
		),
	).toEqual({ type: "retirementCompleted" });
	expect(() => registry.captureScope("account-a", "hidden")).not.toThrow();
	await registry.drainClose();
});

test("prepared cleanup waits for prepare and cannot broaden Account admission", async () => {
	const registry = new WebAttachmentUploadSourceRegistry();
	const preparation = prepareWebAttachmentUploadRuntimeIncarnation(
		registry,
		"startup",
	);
	const control = JSON.stringify({
		type: "retireVaults",
		accountId: "account-a",
		vaultIds: ["visible-again"],
	});
	expect(
		JSON.parse((await registry.invoke(control, "startup")).controlResponseJson),
	).toEqual({ type: "invariantViolation" });
	await preparation;
	expect(
		JSON.parse((await registry.invoke(control, "startup")).controlResponseJson),
	).toEqual({ type: "retired" });
	expect(
		JSON.parse(
			(
				await registry.invoke(
					JSON.stringify({ type: "retireAccount", accountId: "account-a" }),
					"startup",
				)
			).controlResponseJson,
		),
	).toEqual({ type: "invariantViolation" });
	expect(
		JSON.parse(
			(
				await registry.invoke(
					JSON.stringify({
						type: "completeVaultRetirement",
						accountId: "account-a",
						vaultIds: ["visible-again"],
					}),
					"startup",
				)
			).controlResponseJson,
		),
	).toEqual({ type: "retirementCompleted" });
	expect(() => registry.captureScope("account-a", "visible-again")).toThrow();
	await commitWebAttachmentUploadRuntimeIncarnation(registry, "startup");
	expect(() =>
		registry.captureScope("account-a", "visible-again"),
	).not.toThrow();
	await registry.drainClose();
});
