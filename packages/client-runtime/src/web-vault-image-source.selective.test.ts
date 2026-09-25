import { expect, test } from "bun:test";
import {
	activateWebVaultImageSourceRegistry,
	WebVaultImageSourceRegistry,
} from "./web-vault-image-source";

const invoke = (registry: WebVaultImageSourceRegistry, request: unknown) =>
	registry.invoke(JSON.stringify(request), "runtime");
const grant = (
	registry: WebVaultImageSourceRegistry,
	accountId: string,
	vaultId?: string,
) =>
	registry.grant({
		scope: registry.captureScope(accountId, vaultId),
		accountId,
		vaultId,
		contentType: "image/png",
		byteLength: 1n,
		source: { read: async () => new Uint8Array([1]), close: async () => {} },
	});
const claim = (
	capabilityId: string,
	accountId: string,
	vaultId: string,
	operationId = capabilityId,
) => ({
	type: "claim",
	capabilityId,
	accountId,
	vaultId,
	operationId,
	contentType: "image/png",
	byteLength: "1",
});

test("selective image retirement closes only its Vault and fences late picker generations", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const old = registry.captureScope("account", "hidden");
	const hidden = grant(registry, "account", "hidden");
	const visible = grant(registry, "account", "visible");
	const other = grant(registry, "other", "hidden");
	const draft = grant(registry, "account");
	expect(await invoke(registry, claim(hidden, "account", "hidden"))).toEqual({
		type: "claimed",
	});
	expect(
		await invoke(registry, {
			type: "retireVaults",
			accountId: "account",
			vaultIds: ["hidden"],
		}),
	).toEqual({ type: "retired" });
	expect(
		(
			await invoke(registry, {
				type: "read",
				capabilityId: hidden,
				maxBytes: 1,
			})
		).type,
	).not.toBe("chunk");
	expect(() => registry.captureScope("account", "hidden")).toThrow();
	expect(await invoke(registry, claim(visible, "account", "visible"))).toEqual({
		type: "claimed",
	});
	expect(await invoke(registry, claim(other, "other", "hidden"))).toEqual({
		type: "claimed",
	});
	expect(await invoke(registry, claim(draft, "account", "new-vault"))).toEqual({
		type: "claimed",
	});
	expect(
		await invoke(registry, {
			type: "completeVaultRetirement",
			accountId: "account",
			vaultIds: ["hidden"],
		}),
	).toEqual({ type: "retired" });
	expect(() =>
		registry.grant({
			scope: old,
			accountId: "account",
			vaultId: "hidden",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => {} },
		}),
	).toThrow();
	expect(grant(registry, "account", "hidden")).toBeString();
	await registry.drainClose();
});

test("retirement wipes a late plaintext read and drains only its own accepted image", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	let resolveRead!: (bytes: Uint8Array) => void;
	let signalRead!: () => void;
	const started = new Promise<void>((resolve) => {
		signalRead = resolve;
	});
	const hidden = registry.grant({
		scope: registry.captureScope("account", "hidden"),
		accountId: "account",
		vaultId: "hidden",
		contentType: "image/png",
		byteLength: 1n,
		source: {
			read: () => {
				signalRead();
				return new Promise((resolve) => {
					resolveRead = resolve;
				});
			},
			close: async () => {},
		},
	});
	const visible = grant(registry, "account", "visible");
	await invoke(registry, claim(hidden, "account", "hidden"));
	await invoke(registry, claim(visible, "account", "visible"));
	await invoke(registry, { type: "close", capabilityId: visible });
	expect(
		await invoke(registry, {
			type: "beginAcceptance",
			accountId: "account",
			operationId: visible,
		}),
	).toEqual({ type: "acceptanceBegun" });
	const reading = invoke(registry, {
		type: "read",
		capabilityId: hidden,
		maxBytes: 1,
	});
	await started;
	let done = false;
	const retiring = invoke(registry, {
		type: "retireVaults",
		accountId: "account",
		vaultIds: ["hidden"],
	}).then((answer) => {
		done = true;
		return answer;
	});
	await Promise.resolve();
	expect(done).toBe(false);
	expect(
		await invoke(registry, {
			type: "completeVaultRetirement",
			accountId: "account",
			vaultIds: ["hidden"],
		}),
	).toEqual({ type: "sourceFailure" });
	const plaintext = new Uint8Array([7]);
	resolveRead(plaintext);
	expect((await reading).type).toBe("cancelled");
	expect(plaintext).toEqual(new Uint8Array([0]));
	expect(await retiring).toEqual({ type: "retired" });
	expect(
		await invoke(registry, {
			type: "endAcceptance",
			accountId: "account",
			operationId: visible,
		}),
	).toEqual({ type: "acceptanceEnded" });
	await registry.drainClose();
});

test("a later acceptance cannot reuse a completed drain and host discard cannot end it", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	for (const vault of ["first", "hidden"]) {
		const id = grant(registry, "account", vault);
		await invoke(registry, claim(id, "account", vault));
		await invoke(registry, { type: "close", capabilityId: id });
		expect(
			await invoke(registry, {
				type: "beginAcceptance",
				accountId: "account",
				operationId: id,
			}),
		).toEqual({ type: "acceptanceBegun" });
		if (vault === "hidden") {
			let done = false;
			const retiring = invoke(registry, {
				type: "retireVaults",
				accountId: "account",
				vaultIds: [vault],
			}).then((answer) => {
				done = true;
				return answer;
			});
			await registry.discard(id);
			await Promise.resolve();
			expect(done).toBe(false);
			await invoke(registry, {
				type: "endAcceptance",
				accountId: "account",
				operationId: id,
			});
			expect(await retiring).toEqual({ type: "retired" });
		} else
			await invoke(registry, {
				type: "endAcceptance",
				accountId: "account",
				operationId: id,
			});
	}
	await registry.drainClose();
});

test("full capacity still permits Account lock and cannot revive a late picker", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const scope = registry.captureScope("account", "vault");
	for (let index = 0; index < 1021; index++)
		registry.grant({
			scope,
			accountId: "account",
			vaultId: "vault",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => {} },
		});
	expect(
		await invoke(registry, { type: "retireAccount", accountId: "account" }),
	).toEqual({ type: "retired" });
	expect(
		await invoke(registry, {
			type: "completeAccountRetirement",
			accountId: "account",
		}),
	).toEqual({ type: "retired" });
	expect(() =>
		registry.grant({
			scope,
			accountId: "account",
			vaultId: "vault",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => {} },
		}),
	).toThrow();
	expect(registry.captureScope("account", "vault")).toBeDefined();
	await registry.drainClose();
});

test("full capacity still retires a selected Vault without allocating a new identity", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const scope = registry.captureScope("account", "vault");
	for (let index = 0; index < 1021; index++)
		registry.grant({
			scope,
			accountId: "account",
			vaultId: "vault",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => {} },
		});
	expect(
		await invoke(registry, {
			type: "retireVaults",
			accountId: "account",
			vaultIds: ["vault"],
		}),
	).toEqual({ type: "retired" });
	await registry.drainClose();
});

test("Runtime replacement drains the existing image acceptance before admitting a new owner", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const id = grant(registry, "account", "vault");
	await invoke(registry, claim(id, "account", "vault"));
	await invoke(registry, { type: "close", capabilityId: id });
	expect(
		await invoke(registry, {
			type: "beginAcceptance",
			accountId: "account",
			operationId: id,
		}),
	).toEqual({ type: "acceptanceBegun" });
	let done = false;
	const replacing = activateWebVaultImageSourceRegistry(
		registry,
		"replacement",
	).then(() => {
		done = true;
	});
	for (let index = 0; index < 5; index++) await Promise.resolve();
	const premature = done;
	const released = await invoke(registry, {
		type: "endAcceptance",
		accountId: "account",
		operationId: id,
	});
	expect(premature).toBe(false);
	expect(released).toEqual({ type: "acceptanceEnded" });
	await replacing;
	await registry.drainClose();
});

test.each(["close", "retire"] as const)(
	"a late replacement cannot overtake %s while acceptance drains",
	async (boundary) => {
		const registry = new WebVaultImageSourceRegistry();
		await activateWebVaultImageSourceRegistry(registry, "runtime");
		const id = grant(registry, "account", "vault");
		await invoke(registry, claim(id, "account", "vault"));
		await invoke(registry, { type: "close", capabilityId: id });
		await invoke(registry, {
			type: "beginAcceptance",
			accountId: "account",
			operationId: id,
		});
		const replacement = activateWebVaultImageSourceRegistry(
			registry,
			"replacement",
		).then(
			() => true,
			() => false,
		);
		await Promise.resolve();
		const retired =
			boundary === "close"
				? (registry.beginClose(), Promise.resolve())
				: registry.retireRuntime("runtime");
		await invoke(registry, {
			type: "endAcceptance",
			accountId: "account",
			operationId: id,
		});
		const reopened = await replacement;
		await retired;
		expect(reopened).toBe(false);
		expect(() => registry.captureScope("account", "vault")).toThrow();
		await registry.drainClose();
	},
);

test("a late old retirement cannot clear the replacement owner", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const id = grant(registry, "account", "vault");
	await invoke(registry, claim(id, "account", "vault"));
	await invoke(registry, { type: "close", capabilityId: id });
	await invoke(registry, {
		type: "beginAcceptance",
		accountId: "account",
		operationId: id,
	});
	const retirement = registry.retireRuntime("runtime");
	const replacing = activateWebVaultImageSourceRegistry(
		registry,
		"replacement",
	);
	await invoke(registry, {
		type: "endAcceptance",
		accountId: "account",
		operationId: id,
	});
	await Promise.all([retirement, replacing]);
	expect(registry.captureScope("account", "vault")).toBeDefined();
	expect(
		(
			await registry.invoke(
				JSON.stringify({
					type: "claim",
					capabilityId: grant(registry, "account", "vault"),
					accountId: "account",
					vaultId: "vault",
					operationId: "new-operation",
					contentType: "image/png",
					byteLength: "1",
				}),
				"replacement",
			)
		).type,
	).toBe("claimed");
	await registry.drainClose();
});

test("Core Runtime retirement cannot reopen host closing admission", async () => {
	const registry = new WebVaultImageSourceRegistry();
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	registry.beginClose();
	await registry.retireRuntime("runtime");
	await expect(
		activateWebVaultImageSourceRegistry(registry, "replacement"),
	).rejects.toThrow();
	await registry.drainClose();
});
