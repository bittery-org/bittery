import { describe, expect, test } from "bun:test";
import { parseDesktopSnapshotItem } from "../../src/background/desktop-snapshot";
import {
	mergeDesktopAndLocalItemSources,
	mergeItemCollections,
} from "../../src/background/vault-utils";

describe("vault-utils", () => {
	test("keeps verified desktop items when the local travel-mode policy is unavailable", async () => {
		const desktopItems = [
			{
				id: "item_1",
				vaultId: "vault_1",
				title: "Desktop password",
			},
		] as never;
		const localItems = Promise.reject(
			new Error("No verified travel mode policy for account acc-1"),
		);

		const merged = await mergeDesktopAndLocalItemSources(
			Promise.resolve(desktopItems),
			localItems,
		);

		expect(merged).toEqual(desktopItems);
	});

	test("prefers local items over desktop snapshot items with the same id", () => {
		const merged = mergeItemCollections(
			[
				{
					id: "item_1",
					vaultId: "vault_1",
					category: "login",
					favorite: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					title: "Desktop",
					passkeys: [],
					vault: {
						id: "vault_1",
						name: "Personal",
						type: "personal",
						icon: null,
						imageUrl: null,
					},
				},
			] as never,
			[
				{
					id: "item_1",
					vaultId: "vault_1",
					category: "login",
					favorite: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-02T00:00:00.000Z",
					title: "Local",
					passkeys: [
						{
							credentialId: "cred_1",
							rpId: "example.com",
							rpName: "Example",
							userHandle: "user",
							userName: "alice",
							userDisplayName: "Alice",
							privateKey: "private",
							publicKey: "public",
							algorithm: -7,
							signCount: 0,
							transports: ["internal"],
							createdAt: "2026-01-02T00:00:00.000Z",
						},
					],
					vault: {
						id: "vault_1",
						name: "Personal",
						type: "personal",
						icon: null,
						imageUrl: null,
					},
				},
			] as never,
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.title).toBe("Local");
		expect(merged[0]?.passkeys?.[0]?.credentialId).toBe("cred_1");
	});

	test("includes local-only items missing from the desktop snapshot", () => {
		const merged = mergeItemCollections([], [
			{
				id: "item_local",
				vaultId: "vault_1",
				category: "login",
				favorite: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				title: "Local only",
				passkeys: [],
				vault: {
					id: "vault_1",
					name: "Personal",
					type: "personal",
					icon: null,
					imageUrl: null,
				},
			},
		] as never);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe("item_local");
	});

	test("retains passkeys when normalizing desktop snapshot items", () => {
		const normalized = parseDesktopSnapshotItem({
			id: "item_1",
			vaultId: "vault_1",
			category: "login",
			favorite: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			title: "Example",
			passkeys: [
				{
					credentialId: "cred_1",
					rpId: "www.passkeys.io",
					rpName: "passkeys.io",
					userHandle: "user",
					userName: "alice",
					userDisplayName: "Alice",
					privateKey: "private",
					publicKey: "public",
					algorithm: -7,
					signCount: 0,
					transports: ["internal"],
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			vault: {
				id: "vault_1",
				name: "Personal",
				type: "personal",
				icon: null,
				imageUrl: null,
			},
		});

		expect(normalized?.passkeys).toHaveLength(1);
		expect(normalized?.passkeys?.[0]?.credentialId).toBe("cred_1");
	});

	test("retains credit-card and identity fields the desktop app already decrypted", () => {
		const normalized = parseDesktopSnapshotItem({
			id: "item_cc",
			vaultId: "vault_1",
			category: "credit-card",
			favorite: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			title: "My Card",
			cardholderName: "Alice Example",
			cardNumber: "4111111111111111",
			cvv: "123",
			expiryDate: "12/30",
			billingAddress: "1 Example St",
			totpAlgorithm: "SHA256",
			totpDigits: 8,
			totpPeriod: 60,
			linkedItemId: "item_1",
			customFields: [
				{ id: "field_1", label: "PIN", value: "0000", type: "text" },
			],
			vault: {
				id: "vault_1",
				name: "Personal",
				type: "personal",
				icon: null,
				imageUrl: null,
			},
		});

		expect(normalized?.cardholderName).toBe("Alice Example");
		expect(normalized?.cardNumber).toBe("4111111111111111");
		expect(normalized?.cvv).toBe("123");
		expect(normalized?.expiryDate).toBe("12/30");
		expect(normalized?.billingAddress).toBe("1 Example St");
		expect(normalized?.totpAlgorithm).toBe("SHA256");
		expect(normalized?.totpDigits).toBe(8);
		expect(normalized?.totpPeriod).toBe(60);
		expect(normalized?.linkedItemId).toBe("item_1");
		expect(normalized?.customFields).toEqual([
			{ id: "field_1", label: "PIN", value: "0000", type: "text" },
		]);
	});
});
