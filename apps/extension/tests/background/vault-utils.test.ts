import { describe, expect, test } from "bun:test";
import {
	mergeItemCollections,
	normalizeDesktopSnapshotItem,
} from "../../src/background/vault-utils";

describe("vault-utils", () => {
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
		const normalized = normalizeDesktopSnapshotItem({
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
});
