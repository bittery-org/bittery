import { describe, expect, it } from "bun:test";
import type { CachedVaultMetadata } from "@bittery/types";
import { type DeltaSyncClient, performDeltaSync } from "../delta-sync";
import type { ItemCacheAdapter, SyncEvent } from "../types";

type SyncedVaultKey = NonNullable<
	Parameters<NonNullable<ItemCacheAdapter["syncVaultKeys"]>>[0]
>[number];

function serverVault() {
	return {
		id: "vault_1",
		name: "Team Vault",
		vaultType: "team",
		icon: "lock",
		imageUrl: null,
	};
}

function client(): DeltaSyncClient {
	return {
		vault: {
			getItem: {
				query: async () => {
					throw new Error("not used");
				},
			},
			get: {
				query: async () => serverVault(),
			},
			listItems: {
				query: async () => [],
			},
			list: {
				query: async () => [
					{
						...serverVault(),
						encryptedVaultKey: "ZW5jcnlwdGVk",
						role: "owner",
					},
				],
			},
		},
	} as unknown as DeltaSyncClient;
}

function event(overrides: Partial<SyncEvent> = {}): SyncEvent {
	return {
		id: "evt_1",
		type: "vault_member_added",
		entityId: "vault_1",
		entityType: "vault_member",
		vaultId: "vault_1",
		version: 1,
		clientId: null,
		userId: "user_1",
		timestamp: 0,
		...overrides,
	};
}

function recordingCache() {
	const vaultKeys: SyncedVaultKey[] = [];
	const vaults: CachedVaultMetadata[] = [];

	const cache: ItemCacheAdapter = {
		supportsItemCache: true,
		syncVaultKeys: async (keys) => {
			vaultKeys.push(...keys);
		},
		upsertVault: async (vault) => {
			vaults.push(vault);
		},
		upsertEncrypted: async () => undefined,
		removeItem: async () => undefined,
		removeVault: async () => undefined,
	};

	return { cache, vaultKeys, vaults };
}

describe("performDeltaSync vault mapping", () => {
	// Regression guard: the server sends `vaultType`, not `type`. Reading the
	// wrong key cached `vaultType: undefined`, and the vault detail page — which
	// only renders member management for `vaultType === "team"` — silently hid
	// every way to share a team vault until the cache was rebuilt elsewhere.
	it("keeps the team type when refreshing vault keys after a member change", async () => {
		const { cache, vaultKeys } = recordingCache();

		await performDeltaSync(client(), cache, event());

		expect(vaultKeys).toHaveLength(1);
		expect(vaultKeys[0]?.vaultType).toBe("team");
		expect(vaultKeys[0]?.vaultId).toBe("vault_1");
		expect(vaultKeys[0]?.role).toBe("owner");
	});

	it("keeps the team type when caching vault metadata after a vault update", async () => {
		const { cache, vaults } = recordingCache();

		await performDeltaSync(client(), cache, event({ type: "vault_updated" }));

		const cached = vaults.find((vault) => vault.id === "vault_1");
		expect(cached?.type).toBe("team");
	});

	it("still refreshes vault keys when a vault is created", async () => {
		const { cache, vaultKeys } = recordingCache();

		await performDeltaSync(client(), cache, event({ type: "vault_created" }));

		expect(vaultKeys[0]?.vaultType).toBe("team");
	});
});
