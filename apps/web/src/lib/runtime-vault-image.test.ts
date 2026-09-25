import { expect, mock, test } from "bun:test";
import {
	activateWebVaultImageSourceRegistry,
	WebVaultImageSourceRegistry,
} from "../../../../packages/client-runtime/src/web-vault-image-source";

const registry = new WebVaultImageSourceRegistry();
mock.module("./crypto", () => ({
	vaultImageSources: {
		captureScope: (accountId: string) => registry.captureScope(accountId),
		grant: registry.grant.bind(registry),
		discard: registry.discard.bind(registry),
	},
}));
const { prepareRuntimeVaultImageSelection, grantRuntimeVaultImage } =
	await import("./runtime-vault-image");
const invoke = (request: unknown) =>
	registry.invoke(JSON.stringify(request), "runtime");

test("the actual image grant rejects a picker from before Lock after Account readmission", async () => {
	await activateWebVaultImageSourceRegistry(registry, "runtime");
	const selected = prepareRuntimeVaultImageSelection("account");
	await invoke({ type: "retireAccount", accountId: "account" });
	await invoke({ type: "completeAccountRetirement", accountId: "account" });
	const file = new File([new Uint8Array([1, 2, 3])], "image.png", {
		type: "image/png",
	});
	selected(file);
	expect(() => grantRuntimeVaultImage("account", file)).toThrow();
	expect(() => grantRuntimeVaultImage("other", file)).toThrow();
	prepareRuntimeVaultImageSelection("account")(file);
	const granted = grantRuntimeVaultImage("account", file);
	expect(
		await invoke({
			type: "claim",
			accountId: "account",
			vaultId: "new-vault",
			operationId: "operation",
			...granted.input,
		}),
	).toEqual({ type: "claimed" });
	const read = await invoke({
		type: "read",
		capabilityId: granted.input.capabilityId,
		maxBytes: 3,
	});
	expect(read.type).toBe("chunk");
	await granted.discard();
	await granted.discard();
	await registry.drainClose();
});
