import { describe, expect, test } from "bun:test";
import {
	type AtomicAttachmentDownloadSink,
	activateWebAttachmentDownloadRuntimeIncarnation,
	commitWebAttachmentDownloadRuntimeIncarnation,
	isAttachmentDownloadSinkCleanupHostRequest,
	MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES,
	prepareWebAttachmentDownloadRuntimeIncarnation,
	WebAttachmentDownloadSinkExecutor,
	WebAttachmentDownloadSinkRegistry,
} from "./web-attachment-download-sink";

const control = (value: object): string => JSON.stringify(value);
const runtimeScope = "web-runtime-one";
type RegistryOptions = ConstructorParameters<
	typeof WebAttachmentDownloadSinkRegistry
>[0];

async function activeRegistry(
	options: RegistryOptions = {},
): Promise<WebAttachmentDownloadSinkRegistry> {
	const registry = new WebAttachmentDownloadSinkRegistry(options);
	await activateWebAttachmentDownloadRuntimeIncarnation(registry, runtimeScope);
	return registry;
}

const emptySink = (): AtomicAttachmentDownloadSink => ({
	write: async (_bytes: Uint8Array) => undefined,
	commit: async () => undefined,
	discard: async () => undefined,
});
function grant(
	registry: WebAttachmentDownloadSinkRegistry,
	sink = emptySink(),
): string {
	return registry.grant({
		accountId: "account-one",
		attachmentId: "attachment-one",
		sink,
	});
}
function begin(capabilityId: string, accountId = "account-one"): string {
	return control({
		type: "begin",
		accountId,
		attachmentId: "attachment-one",
		capabilityId,
		requestScope: capabilityId,
	});
}

describe("Web Attachment Download sink capabilities", () => {
	test("one total bound backpressures grants without evicting live cleanup identities", async () => {
		let next = 0;
		const registry = await activeRegistry({
			identity: () => `bounded-${next++}`,
		});
		const capabilities = Array.from(
			{ length: MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 2 },
			() => grant(registry),
		);
		expect(() => grant(registry)).toThrow("capacity");
		const first = capabilities[0] as string;
		await registry.invoke(begin(first), undefined, runtimeScope);
		// Ignore the successful discard acknowledgement, then prove its replay identity survives
		// even though the total budget remains full.
		await registry.invoke(
			control({ type: "discard", capabilityId: first }),
			undefined,
			runtimeScope,
		);
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId: first }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		expect(() => grant(registry)).toThrow("capacity");
	});

	test("expired untouched grants are discarded and release total capacity", async () => {
		let now = 1;
		let next = 0;
		let discards = 0;
		const registry = await activeRegistry({
			now: () => now,
			identity: () => `expiring-${next++}`,
		});
		const capabilities = Array.from(
			{ length: MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 2 },
			() =>
				registry.grant({
					accountId: "account-one",
					attachmentId: "attachment-one",
					expiresAt: 2,
					sink: {
						...emptySink(),
						discard: async () => {
							discards += 1;
						},
					},
				}),
		);
		now = 3;
		expect(
			await registry.invoke(
				begin(capabilities[0] as string),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(discards).toBe(MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 2);
		expect(() => grant(registry)).not.toThrow();
	});
	test("requires the trusted Runtime handshake before a grant", () => {
		const registry = new WebAttachmentDownloadSinkRegistry({
			identity: () => "capability-one",
		});
		expect(() => grant(registry)).toThrow();
	});

	test("pending Runtime scope is cleanup-only until exact commit and retire aborts it", async () => {
		const registry = new WebAttachmentDownloadSinkRegistry({
			identity: () => "pending-capability",
		});
		await prepareWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"pending-runtime",
		);
		expect(() => grant(registry)).toThrow();
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				"foreign-runtime",
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				"pending-runtime",
			),
		).toBe('{"type":"retired"}');
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				"pending-runtime",
			),
		).toBe('{"type":"retired"}');
		await expect(
			commitWebAttachmentDownloadRuntimeIncarnation(
				registry,
				"pending-runtime",
			),
		).rejects.toThrow();
		await prepareWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"fresh-runtime",
		);
		await commitWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"fresh-runtime",
		);
		expect(() => grant(registry)).not.toThrow();
	});

	test("binds Account, actual Runtime incarnation, Attachment, and exactly one request", async () => {
		const provisional: number[] = [];
		let published: number[] | undefined;
		let discarded = 0;
		const registry = await activeRegistry({ identity: () => "capability-one" });
		const capabilityId = grant(registry, {
			write: async (bytes) => {
				provisional.push(...bytes);
			},
			commit: async () => {
				published = [...provisional];
			},
			discard: async () => {
				provisional.length = 0;
				discarded += 1;
			},
		});
		expect(
			await registry.invoke(
				begin(capabilityId, "foreign"),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(begin(capabilityId), undefined, "foreign-runtime"),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({
					type: "begin",
					accountId: "account-one",
					attachmentId: "attachment-one",
					capabilityId,
					requestScope: "foreign-request",
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(begin(capabilityId), undefined, runtimeScope),
		).toBe('{"type":"begun"}');
		expect(
			await registry.invoke(
				control({ type: "write", capabilityId }),
				new Uint8Array([1, 2, 3]),
				runtimeScope,
			),
		).toBe('{"type":"written"}');
		expect(published).toBeUndefined();
		expect(
			await registry.invoke(
				control({ type: "commit", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"committed"}');
		expect(published).toEqual([1, 2, 3]);
		expect(discarded).toBe(0);
		expect(
			await registry.invoke(begin(capabilityId), undefined, runtimeScope),
		).toBe('{"type":"invariantViolation"}');
	});

	test("compensating discard converges before begin, after begun response loss, and rejects foreign scope", async () => {
		let discarded = 0;
		const identities = ["before-begin", "response-lost"];
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "unexpected",
		});
		const first = grant(registry, {
			...emptySink(),
			discard: async () => {
				discarded += 1;
			},
		});
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId: first }),
				undefined,
				"foreign-runtime",
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId: first }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		expect(discarded).toBe(1);
		expect(await registry.invoke(begin(first), undefined, runtimeScope)).toBe(
			'{"type":"invariantViolation"}',
		);

		const second = grant(registry, {
			...emptySink(),
			discard: async () => {
				discarded += 1;
			},
		});
		// The host transitioned to begun; model a lost/malformed acknowledgement by ignoring it.
		await registry.invoke(begin(second), undefined, runtimeScope);
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId: second }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		expect(discarded).toBe(2);
	});

	test("Runtime reconstruction rotates scope and discards every old grant", async () => {
		let discarded = 0;
		const identities = ["old-capability", "new-capability"];
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "none",
		});
		const old = grant(registry, {
			...emptySink(),
			discard: async () => {
				discarded += 1;
			},
		});
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		await activateWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"web-runtime-two",
		);
		expect(discarded).toBe(1);
		expect(await registry.invoke(begin(old), undefined, runtimeScope)).toBe(
			'{"type":"invariantViolation"}',
		);
		const current = grant(registry);
		expect(
			await registry.invoke(begin(current), undefined, "web-runtime-two"),
		).toBe('{"type":"begun"}');
	});

	test("validates finite clocks and positive bounded non-overflowing lifetimes", async () => {
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY])
			expect(
				() => new WebAttachmentDownloadSinkRegistry({ now: () => now }),
			).toThrow();
		for (const defaultLifetimeMs of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			3_600_001,
		])
			expect(
				() => new WebAttachmentDownloadSinkRegistry({ defaultLifetimeMs }),
			).toThrow();
		let now = 10;
		const registry = await activeRegistry({
			now: () => now,
			identity: () => "expiry",
		});
		for (const expiresAt of [
			10,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			3_600_011,
		])
			expect(() =>
				registry.grant({
					accountId: "a",
					attachmentId: "b",
					expiresAt,
					sink: emptySink(),
				}),
			).toThrow();
		now = Number.MAX_VALUE;
		expect(() =>
			registry.grant({ accountId: "a", attachmentId: "b", sink: emptySink() }),
		).toThrow();
		now = 20;
		const capabilityId = registry.grant({
			accountId: "a",
			attachmentId: "b",
			expiresAt: 30,
			sink: emptySink(),
		});
		now = Number.NaN;
		expect(
			await registry.invoke(
				control({
					type: "begin",
					accountId: "a",
					attachmentId: "b",
					capabilityId,
					requestScope: capabilityId,
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
	});

	test("accepts capability identity lengths 1 and 128 and rejects 0 and 129", async () => {
		for (const identity of ["x", "x".repeat(128)])
			expect(grant(await activeRegistry({ identity: () => identity }))).toBe(
				identity,
			);
		async function rejected(identity: string): Promise<boolean> {
			const registry = await activeRegistry({ identity: () => identity });
			try {
				grant(registry);
				return false;
			} catch {
				return true;
			}
		}
		expect(await rejected("")).toBe(true);
		expect(await rejected("x".repeat(129))).toBe(true);
	});

	for (const callback of ["write", "commit", "discard"] as const) {
		test(`reentrant close from ${callback} fails closed without self-wait or false completion`, async () => {
			let closeError: unknown;
			const registry = await activeRegistry({
				identity: () => `reentrant-${callback}`,
			});
			const reenter = async () => {
				closeError = await registry.close().catch((error: unknown) => error);
			};
			const capabilityId = grant(registry, {
				write: callback === "write" ? reenter : emptySink().write,
				commit: callback === "commit" ? reenter : emptySink().commit,
				discard: callback === "discard" ? reenter : emptySink().discard,
			});
			await registry.invoke(begin(capabilityId), undefined, runtimeScope);
			const response = await registry.invoke(
				control({ type: callback, capabilityId }),
				callback === "write" ? new Uint8Array([1]) : undefined,
				runtimeScope,
			);
			expect(closeError).toBeInstanceOf(Error);
			expect(response).toBe(
				`{"type":"${callback === "write" ? "written" : callback === "commit" ? "committed" : "discarded"}"}`,
			);
			await registry.drainClose();
			expect(() => grant(registry)).toThrow();
		});
	}

	test("close phase fences begin/write/commit, permits discard, and drains it", async () => {
		let discarded = 0;
		const registry = await activeRegistry({
			identity: () => "closing-capability",
		});
		const capabilityId = grant(registry, {
			write: async () => undefined,
			commit: async () => {
				throw new Error("must stay fenced");
			},
			discard: async () => {
				discarded += 1;
			},
		});
		await registry.invoke(begin(capabilityId), undefined, runtimeScope);
		registry.beginClose();
		expect(
			await registry.invoke(
				control({ type: "write", capabilityId }),
				new Uint8Array([1]),
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({ type: "commit", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		await registry.drainClose();
		expect(discarded).toBe(1);
	});

	test("executor never self-activates and wipes retained chunks", async () => {
		const requests: unknown[] = [];
		const chunk = new Uint8Array([7, 8, 9]);
		const executor = new WebAttachmentDownloadSinkExecutor(async (payload) => {
			requests.push(payload);
			return '{"type":"written"}';
		}, runtimeScope);
		await executor.invoke(control({ type: "write", capabilityId: "x" }), chunk);
		expect(chunk).toEqual(new Uint8Array([0, 0, 0]));
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			type: "attachmentDownloadSink",
			runtimeIncarnation: runtimeScope,
			controlRequestJson: control({ type: "write", capabilityId: "x" }),
			binaryChunk: new Uint8Array([0, 0, 0]),
		});
	});

	test("failed retirement retains fenced cleanup ownership until the same scope retries", async () => {
		let attempts = 0;
		const identities = ["retained", "current"];
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "unexpected",
		});
		const old = grant(registry, {
			...emptySink(),
			discard: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("cleanup failed");
			},
		});
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		expect(() => grant(registry)).toThrow();
		expect(await registry.invoke(begin(old), undefined, runtimeScope)).toBe(
			'{"type":"invariantViolation"}',
		);
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		await activateWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"runtime-three",
		);
		expect(attempts).toBe(2);
		const current = grant(registry);
		expect(
			await registry.invoke(begin(current), undefined, "runtime-three"),
		).toBe('{"type":"begun"}');
		expect(
			await registry.invoke(begin(current), undefined, "runtime-two"),
		).toBe('{"type":"invariantViolation"}');
	});

	test("retirement fences grants while old cleanup is still draining", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = await activeRegistry({ identity: () => "early-grant" });
		grant(registry, { ...emptySink(), discard: async () => blocked });
		const retirement = registry.invoke(
			control({ type: "retireRuntime" }),
			undefined,
			runtimeScope,
		);
		await Promise.resolve();
		expect(() => grant(registry)).toThrow();
		release();
		expect(await retirement).toBe('{"type":"retired"}');
		await activateWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"runtime-next",
		);
		expect(() => grant(registry)).not.toThrow();
	});

	test("close fencing a retired Runtime prevents a fresh scope from becoming active", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = await activeRegistry({ identity: () => "close-rotation" });
		grant(registry, { ...emptySink(), discard: async () => blocked });
		const retirement = registry.invoke(
			control({ type: "retireRuntime" }),
			undefined,
			runtimeScope,
		);
		await Promise.resolve();
		const close = registry.drainClose();
		release();
		expect(await retirement).toBe('{"type":"retired"}');
		await expect(
			activateWebAttachmentDownloadRuntimeIncarnation(registry, "runtime-next"),
		).rejects.toThrow();
		await close;
		expect(() => grant(registry)).toThrow();
	});

	test("beginClose stays terminal when it races the awaited half of Runtime retirement", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = await activeRegistry({ identity: () => "mid-retirement" });
		grant(registry, { ...emptySink(), discard: async () => blocked });
		const retirement = registry.invoke(
			control({ type: "retireRuntime" }),
			undefined,
			runtimeScope,
		);
		await Promise.resolve();
		registry.beginClose();
		release();
		expect(await retirement).toBe('{"type":"retired"}');
		await expect(
			prepareWebAttachmentDownloadRuntimeIncarnation(registry, "after-close"),
		).rejects.toThrow();
		await registry.drainClose();
	});

	test("a failed commit retains cleanup ownership until explicit discard retries", async () => {
		let discards = 0;
		const registry = await activeRegistry({ identity: () => "commit-cleanup" });
		const capabilityId = grant(registry, {
			...emptySink(),
			commit: async () => {
				throw new Error("commit failed");
			},
			discard: async () => {
				discards += 1;
				if (discards === 1) throw new Error("discard failed");
			},
		});
		await registry.invoke(begin(capabilityId), undefined, runtimeScope);
		expect(
			await registry.invoke(
				control({ type: "commit", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		expect(discards).toBe(2);
	});

	test("discard and close cleanup failures retain identity and converge on retry", async () => {
		let attempts = 0;
		const registry = await activeRegistry({ identity: () => "cleanup-retry" });
		const capabilityId = grant(registry, {
			...emptySink(),
			discard: async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("cleanup failed");
			},
		});
		await registry.invoke(begin(capabilityId), undefined, runtimeScope);
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		await expect(registry.drainClose()).rejects.toThrow("cleanup failed");
		await expect(registry.drainClose()).resolves.toBeUndefined();
		expect(attempts).toBe(3);
	});

	test("lost, malformed, and rejected discard answers retain one exactly-once cleanup identity", async () => {
		let attempts = 0;
		const registry = await activeRegistry({ identity: () => "discard-rpc" });
		const capabilityId = grant(registry, {
			...emptySink(),
			discard: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("rejected discard");
			},
		});
		await registry.invoke(begin(capabilityId), undefined, runtimeScope);
		expect(
			await registry.invoke(
				control({ type: "discard", capability: capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		// Ignore the successful response to model loss, then replay the exact identity.
		await registry.invoke(
			control({ type: "discard", capabilityId }),
			undefined,
			runtimeScope,
		);
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		expect(attempts).toBe(2);
		await registry.drainClose();
	});

	test("Account retirement stays fenced through Core convergence and reopens only on completion", async () => {
		let attempts = 0;
		const identities = ["old-account", "other-account", "new-account"];
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "unexpected",
		});
		grant(registry, {
			...emptySink(),
			discard: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("lost cleanup acknowledgement");
			},
		});
		const other = registry.grant({
			accountId: "account-two",
			attachmentId: "attachment-two",
			sink: emptySink(),
		});
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "account-one" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		expect(() => grant(registry)).toThrow();
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "account-one" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		expect(attempts).toBe(2);
		expect(() => grant(registry)).toThrow();
		expect(
			await registry.invoke(
				control({
					type: "completeAccountRetirement",
					accountId: "account-one",
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retirementCompleted"}');
		const current = grant(registry);
		expect(await registry.invoke(begin(current), undefined, runtimeScope)).toBe(
			'{"type":"begun"}',
		);
		expect(
			await registry.invoke(
				control({
					type: "begin",
					accountId: "account-two",
					attachmentId: "attachment-two",
					capabilityId: other,
					requestScope: other,
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"begun"}');
		await registry.drainClose();
	});

	test("an empty Account retirement fences grants until its exact completion", async () => {
		const registry = await activeRegistry({ identity: () => "after-empty" });
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "empty-account" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		expect(() =>
			registry.grant({
				accountId: "empty-account",
				attachmentId: "attachment-one",
				sink: emptySink(),
			}),
		).toThrow();
		expect(
			await registry.invoke(
				control({
					type: "completeAccountRetirement",
					accountId: "empty-account",
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retirementCompleted"}');
		expect(() =>
			registry.grant({
				accountId: "empty-account",
				attachmentId: "attachment-one",
				sink: emptySink(),
			}),
		).not.toThrow();
		await registry.drainClose();
	});

	test("close admits and drains the exact Account retirement completion request", async () => {
		const registry = await activeRegistry();
		await registry.invoke(
			control({ type: "retireAccount", accountId: "closing-account" }),
			undefined,
			runtimeScope,
		);
		const request = {
			type: "attachmentDownloadSink" as const,
			runtimeIncarnation: runtimeScope,
			controlRequestJson: control({
				type: "completeAccountRetirement",
				accountId: "closing-account",
			}),
		};
		expect(isAttachmentDownloadSinkCleanupHostRequest(request)).toBe(true);
		registry.beginClose();
		expect(
			await registry.invoke(
				request.controlRequestJson,
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retirementCompleted"}');
		await registry.drainClose();
	});

	test("Account retirement retry tombstones one generation and fences its replacement independently", async () => {
		const identities = ["generation-one", "generation-two"];
		let firstDiscards = 0;
		let secondDiscards = 0;
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "unexpected",
		});
		const first = grant(registry, {
			...emptySink(),
			discard: async () => {
				firstDiscards += 1;
				if (firstDiscards === 1) throw new Error("retry first generation");
			},
		});
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "account-one" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "account-one" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		expect(
			await registry.invoke(
				control({ type: "discard", capabilityId: first }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"discarded"}');
		await registry.invoke(
			control({
				type: "completeAccountRetirement",
				accountId: "account-one",
			}),
			undefined,
			runtimeScope,
		);
		grant(registry, {
			...emptySink(),
			discard: async () => {
				secondDiscards += 1;
			},
		});
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "account-one" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		expect(firstDiscards).toBe(2);
		expect(secondDiscards).toBe(1);
		await registry.drainClose();
	});

	test("empty Account retirement fences consume one bounded identity budget", async () => {
		const registry = await activeRegistry();
		for (
			let index = 0;
			index < MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 1;
			index += 1
		) {
			expect(
				await registry.invoke(
					control({ type: "retireAccount", accountId: `empty-${index}` }),
					undefined,
					runtimeScope,
				),
			).toBe('{"type":"retired"}');
		}
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "one-too-many" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"sinkFailure"}');
		expect(
			await registry.invoke(
				control({
					type: "completeAccountRetirement",
					accountId: "empty-0",
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retirementCompleted"}');
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "one-more" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		await registry.drainClose();
	});

	test("mixed Runtime, replay, Account, retirement, and sink state stops exactly at 1024 and cleanup frees capacity", async () => {
		let next = 0;
		const registry = await activeRegistry({
			identity: () => `mixed-${next++}`,
		});
		const replayed = grant(registry);
		await registry.invoke(begin(replayed), undefined, runtimeScope);
		await registry.invoke(
			control({ type: "discard", capabilityId: replayed }),
			undefined,
			runtimeScope,
		);
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "retiring-account" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		for (let index = 0; index < 1020; index += 1) {
			registry.grant({
				accountId: "live-account",
				attachmentId: `attachment-${index}`,
				sink: emptySink(),
			});
		}
		expect(() =>
			registry.grant({
				accountId: "live-account",
				attachmentId: "identity-1025",
				sink: emptySink(),
			}),
		).toThrow("capacity");
		expect(
			await registry.invoke(
				control({
					type: "completeAccountRetirement",
					accountId: "retiring-account",
				}),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retirementCompleted"}');
		expect(() =>
			registry.grant({
				accountId: "live-account",
				attachmentId: "freed-capacity",
				sink: emptySink(),
			}),
		).not.toThrow();
		await registry.drainClose();
	});

	test("Runtime retirement is idempotent and permanently fences that exact scope", async () => {
		const identities = ["old-runtime", "new-runtime"];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = await activeRegistry({
			identity: () => identities.shift() ?? "unexpected",
		});
		grant(registry, { ...emptySink(), discard: async () => held });
		const retirement = registry.invoke(
			control({ type: "retireRuntime" }),
			undefined,
			runtimeScope,
		);
		await Promise.resolve();
		expect(() => grant(registry)).toThrow();
		release();
		expect(await retirement).toBe('{"type":"retired"}');
		expect(() => grant(registry)).toThrow();
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		await prepareWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"web-runtime-two",
		);
		await commitWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"web-runtime-two",
		);
		const current = grant(registry);
		expect(await registry.invoke(begin(current), undefined, runtimeScope)).toBe(
			'{"type":"invariantViolation"}',
		);
		expect(
			await registry.invoke(begin(current), undefined, "web-runtime-two"),
		).toBe('{"type":"begun"}');
		await registry.drainClose();
	});

	test("fresh Runtime prepare replaces one retired scope slot at exact capacity", async () => {
		let next = 0;
		const registry = await activeRegistry({
			identity: () => `runtime-slot-${next++}`,
		});
		const capabilities = Array.from({ length: 1022 }, () => grant(registry));
		for (const capabilityId of capabilities) {
			expect(
				await registry.invoke(
					control({ type: "discard", capabilityId }),
					undefined,
					runtimeScope,
				),
			).toBe('{"type":"discarded"}');
		}
		expect(
			await registry.invoke(
				control({ type: "retireAccount", accountId: "pending-empty" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"retired"}');

		await expect(
			prepareWebAttachmentDownloadRuntimeIncarnation(registry, "fresh-runtime"),
		).resolves.toBeUndefined();
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		await commitWebAttachmentDownloadRuntimeIncarnation(
			registry,
			"fresh-runtime",
		);
		const freshCapability = grant(registry);
		expect(
			await registry.invoke(
				control({ type: "retireRuntime" }),
				undefined,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(begin(freshCapability), undefined, runtimeScope),
		).toBe('{"type":"invariantViolation"}');
		expect(
			await registry.invoke(begin(freshCapability), undefined, "fresh-runtime"),
		).toBe('{"type":"begun"}');
		await registry.drainClose();
	});

	test("an exact-capacity expiry burst owns one bounded cleanup per identity", async () => {
		let now = 1;
		let next = 0;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let discards = 0;
		const registry = await activeRegistry({
			now: () => now,
			identity: () => `burst-${next++}`,
		});
		const capabilities = Array.from(
			{ length: MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 2 },
			() =>
				registry.grant({
					accountId: "account-one",
					attachmentId: "attachment-one",
					expiresAt: 2,
					sink: {
						...emptySink(),
						discard: async () => {
							discards += 1;
							await held;
						},
					},
				}),
		);
		now = 3;
		const repeatedInvocations: Promise<string>[] = [];
		for (let attempt = 0; attempt < 32; attempt += 1) {
			expect(() => grant(registry)).toThrow();
			const capabilityId = capabilities[attempt] as string;
			repeatedInvocations.push(
				registry.invoke(
					attempt % 2 === 0
						? begin(capabilityId)
						: control({ type: "discard", capabilityId }),
					undefined,
					runtimeScope,
				),
			);
		}
		await Promise.resolve();
		expect(discards).toBe(MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES - 2);
		release();
		await Promise.all(repeatedInvocations);
		await registry.invoke(
			begin(capabilities[0] as string),
			undefined,
			runtimeScope,
		);
		expect(() => grant(registry)).not.toThrow();
	});

	test("rejects a partial received view and wipes its entire backing buffer", async () => {
		let writes = 0;
		const registry = await activeRegistry({ identity: () => "partial-view" });
		const capabilityId = grant(registry, {
			...emptySink(),
			write: async () => {
				writes += 1;
			},
		});
		await registry.invoke(begin(capabilityId), undefined, runtimeScope);
		const backing = new Uint8Array([9, 1, 2, 8]);
		const partial = new Uint8Array(backing.buffer, 1, 2);
		expect(
			await registry.invoke(
				control({ type: "write", capabilityId }),
				partial,
				runtimeScope,
			),
		).toBe('{"type":"invariantViolation"}');
		expect(backing).toEqual(new Uint8Array(4));
		expect(writes).toBe(0);
		await registry.drainClose();
	});

	test("main-thread plaintext references are wiped after success and rejection", async () => {
		for (const reject of [false, true]) {
			let retained: Uint8Array | undefined;
			const registry = await activeRegistry({
				identity: () => `wipe-${reject}`,
			});
			const capabilityId = grant(registry, {
				...emptySink(),
				write: async (bytes) => {
					retained = bytes;
					if (reject) throw new Error("sink rejected");
				},
			});
			await registry.invoke(begin(capabilityId), undefined, runtimeScope);
			await registry.invoke(
				control({ type: "write", capabilityId }),
				new Uint8Array([4, 5, 6]),
				runtimeScope,
			);
			expect(retained).toEqual(new Uint8Array([0, 0, 0]));
			await registry.drainClose();
		}
	});
});
