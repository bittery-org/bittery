import { describe, expect, test } from "bun:test";
import type { DecryptedItemData } from "@bittery/shared/types";
import type { ItemSyncCommand } from "@bittery/types";
import { type ItemCommandRepositoryPort, ItemCommands } from "./item-commands";

const login: DecryptedItemData = {
	title: "Example",
	username: "alice",
	password: "old",
};

function fixture() {
	const queued: ItemSyncCommand[] = [];
	const encrypted: Array<{
		vaultId: string;
		data: DecryptedItemData;
		version: number;
		userId?: string;
	}> = [];
	const item = {
		id: "item-1",
		vaultId: "vault-1",
		category: "login" as const,
		favorite: false,
		createdAt: "2024-01-01",
		updatedAt: "2024-01-01",
		deletedAt: null,
		version: 7,
		lastModifiedBy: "user-1",
		encryptionVersion: 7,
		encryptedByUserId: "user-1",
		_encrypted: { data: "cipher", iv: "iv", algorithm: "AES" },
		vault: {
			id: "vault-1",
			name: "One",
			type: "personal",
			icon: null,
			imageUrl: null,
		},
		...login,
	};
	const repo: ItemCommandRepositoryPort = {
		findAccountForVault: (id) =>
			["vault-1", "vault-2"].includes(id)
				? { accountId: "account-1" }
				: undefined,
		getAccountInfo: (id) =>
			id === "account-1" ? { email: "alice@example.com" } : undefined,
		getById: (id) => (id === item.id ? item : undefined),
		getDeleted: () => [],
		encryptForVault: async ({ vaultId, data, version, userId }) => {
			encrypted.push({
				vaultId,
				data,
				version,
				userId,
			});
			return {
				ciphertext: `sealed-${version}`,
				iv: "iv",
				algorithm: "AES",
				encryptionVersion: version,
				encryptedByUserId: userId ?? "user-1",
			};
		},
	};
	const commands = new ItemCommands({
		queue: {
			enqueue: async (command) => {
				queued.push(command);
			},
		},
		repository: repo,
		resolveUserId: async () => "authenticated-user",
		generateId: async () => "generated-id",
		now: () => 123,
	});
	return { commands, encrypted, queued };
}

describe("ItemCommands", () => {
	test("owns creation encryption, identifiers, and durable command construction", async () => {
		const { commands, queued } = fixture();
		const result = await commands.execute({
			type: "create",
			vaultId: "vault-1",
			category: "login",
			data: login,
			accountId: "account-1",
		});
		expect(result).toEqual({ itemId: "generated-id" });
		expect(queued[0]).toMatchObject({
			id: "generated-id",
			operationId: "generated-id",
			timestamp: 123,
			retryCount: 0,
			type: "create",
			entityId: "generated-id",
			baseVersion: 0,
			accountId: "account-1",
		});
	});

	test("merges login updates with password history before encrypting the next revision", async () => {
		const { commands, encrypted, queued } = fixture();
		await commands.execute({
			type: "update",
			itemId: "item-1",
			vaultId: "vault-1",
			data: { password: "new" },
			accountId: "account-1",
		});
		expect(encrypted[0]).toMatchObject({
			vaultId: "vault-1",
			version: 8,
			data: { password: "new", passwordHistory: [{ password: "old" }] },
		});
		expect(queued[0]).toMatchObject({
			type: "update",
			baseVersion: 7,
			entityId: "item-1",
		});
	});

	test("uses authenticated user context for a same-account move", async () => {
		const { commands, encrypted, queued } = fixture();
		const result = await commands.execute({
			type: "move",
			itemId: "item-1",
			sourceVaultId: "vault-1",
			targetVaultId: "vault-2",
			category: "login",
			decryptedData: login,
			accountId: "account-1",
			targetAccountId: "account-1",
		});
		expect(result).toMatchObject({ crossAccount: false });
		expect(encrypted[0]).toMatchObject({
			vaultId: "vault-2",
			version: 8,
			userId: "authenticated-user",
		});
		expect(queued[0]).toMatchObject({ type: "move", targetVaultId: "vault-2" });
	});

	test("rejects an account email where a stable account ID is required", async () => {
		const { commands, queued } = fixture();

		await expect(
			commands.execute({
				type: "create",
				vaultId: "vault-1",
				category: "login",
				data: login,
				accountId: "alice@example.com",
			}),
		).rejects.toThrow("No account repository found for vault vault-1");
		expect(queued).toHaveLength(0);
	});

	test("rejects a move whose source vault does not own the item", async () => {
		const { commands, queued } = fixture();

		await expect(
			commands.execute({
				type: "move",
				itemId: "item-1",
				sourceVaultId: "vault-2",
				targetVaultId: "vault-1",
				category: "login",
				decryptedData: login,
				accountId: "account-1",
				targetAccountId: "account-1",
			}),
		).rejects.toThrow("Item item-1 does not belong to vault vault-2");
		expect(queued).toHaveLength(0);
	});
});
