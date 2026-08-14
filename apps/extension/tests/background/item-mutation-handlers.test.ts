import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

const backgroundDir = path.resolve(import.meta.dir, "../../src/background");
const createCalls: unknown[] = [];
const updateCalls: unknown[] = [];

mock.module(path.join(backgroundDir, "extension-item-mutations.ts"), () => ({
	createExtensionItem: async (input: unknown) => {
		createCalls.push(input);
		return { itemId: "local-item-id" };
	},
	updateExtensionItem: async (input: unknown) => {
		updateCalls.push(input);
	},
}));

mock.module(path.join(backgroundDir, "core-instance.ts"), () => ({
	core: {
		vaultRepository: {
			getById: () => ({
				id: "item-1",
				vaultId: "vault-1",
				category: "login",
				version: 4,
				title: "Example",
				totpIssuer: "Existing issuer",
			}),
		},
	},
}));

mock.module(path.join(backgroundDir, "desktop-key-material.ts"), () => ({
	ensureDesktopWriteCapability: async () => true,
}));

mock.module(path.join(backgroundDir, "services/account-resolution.ts"), () => ({
	resolveAccountIdForItem: async () => "account-alice",
	resolveAccountIdForVault: async () => "account-alice",
}));

mock.module(path.join(backgroundDir, "session-manager.ts"), () => ({
	ensureUnlockedOrRecoverFromDesktop: async () => true,
	updateActivity: () => {},
}));

mock.module(path.join(backgroundDir, "vault-utils.ts"), () => ({
	getDecryptedItemsForCurrentMode: async () => [
		{
			id: "item-1",
			vaultId: "vault-1",
			category: "login",
			version: 4,
			title: "Example",
			totpIssuer: "Existing issuer",
		},
	],
}));

const { handleSaveNewCredential, handleUpdateExistingCredential } =
	await import("../../src/background/credential-handlers");
const { handleUpdateItemTotp } = await import(
	"../../src/background/qr-scan-handlers"
);

describe("background Item mutation handlers", () => {
	test("credential capture submits create and update commands", async () => {
		expect(
			await handleSaveNewCredential({
				vaultId: "vault-1",
				username: "alice",
				password: "password",
				url: "https://example.com/login",
			}),
		).toEqual({ success: true, itemId: "local-item-id" });

		expect(
			await handleUpdateExistingCredential({
				itemId: "item-1",
				vaultId: "vault-1",
				username: "alice",
				password: "new-password",
				url: "https://example.com/login",
			}),
		).toEqual({ success: true });

		expect(createCalls).toHaveLength(1);
		expect(updateCalls[0]).toMatchObject({
			itemId: "item-1",
			accountId: "account-alice",
			data: { password: "new-password" },
		});
	});

	test("QR TOTP updates submit one semantic update command", async () => {
		const result = await handleUpdateItemTotp({
			itemId: "item-1",
			totp: { totpSecret: "secret", totpAccountName: "alice" },
		});

		expect(result).toMatchObject({ success: true });
		expect(updateCalls.at(-1)).toMatchObject({
			itemId: "item-1",
			accountId: "account-alice",
			data: {
				totpSecret: "secret",
				totpIssuer: "Existing issuer",
				totpAccountName: "alice",
				totpAlgorithm: "SHA1",
				totpDigits: 6,
				totpPeriod: 30,
			},
		});
	});
});
