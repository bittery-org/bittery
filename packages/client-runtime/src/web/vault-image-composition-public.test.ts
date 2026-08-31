import { describe, expect, test } from "bun:test";
import type { VaultImageSourceGrants, WebClientRuntime } from "./composition";
import { createVaultImageSourceRegistryOwner } from "./vault-image-runtime-incarnation";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <
		Value,
	>() => Value extends Right ? 1 : 2
		? true
		: false;
type Assert<Value extends true> = Value;

type _GrantFacadeStaysShallow = Assert<
	Equal<keyof VaultImageSourceGrants, "grant">
>;
type _CompositionDoesNotExposeRegistryAuthority = Assert<
	Equal<"vaultImages" extends keyof WebClientRuntime ? true : false, false>
>;
const compileTimeSurfaceAssertions: [
	_GrantFacadeStaysShallow,
	_CompositionDoesNotExposeRegistryAuthority,
] = [true, true];

describe("Vault-image Web composition public surface", () => {
	test("exposes only the host source grant and keeps acceptance/retirement in Runtime controls", () => {
		expect(compileTimeSurfaceAssertions).toEqual([true, true]);
	});

	test("failed-open recovery drains the old production registry before using a fresh identity", async () => {
		let identity = 0;
		let releaseCleanup!: () => void;
		const heldCleanup = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let cleanupStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			cleanupStarted = resolve;
		});
		const owner = createVaultImageSourceRegistryOwner({
			identity: () => `capability-${identity++}`,
		});
		await owner.prepare("runtime-old");
		const oldCapability = owner.grants.grant({
			accountId: "account-a",
			operationId: "operation-old",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: {
				read: async () => null,
				close: async () => {
					cleanupStarted();
					await heldCleanup;
				},
			},
		});
		let prepared = false;
		const recovery = owner.prepare("runtime-new").then(() => {
			prepared = true;
		});
		await started;
		expect(prepared).toBe(false);
		releaseCleanup();
		await recovery;
		const newCapability = owner.grants.grant({
			accountId: "account-a",
			operationId: "operation-new",
			vaultId: "vault-a",
			contentType: "image/png",
			byteLength: 1n,
			source: { read: async () => null, close: async () => {} },
		});
		expect(newCapability).not.toBe(oldCapability);
		expect(
			(
				await owner.invoke(
					JSON.stringify({
						type: "claim",
						capabilityId: oldCapability,
						accountId: "account-a",
						operationId: "operation-old",
						vaultId: "vault-a",
						contentType: "image/png",
						byteLength: "1",
					}),
					"runtime-old",
				)
			).type,
		).toBe("sourceFailure");
		expect(Object.keys(owner.grants)).toEqual(["grant"]);
		expect("registry" in owner).toBe(false);
	});
});
