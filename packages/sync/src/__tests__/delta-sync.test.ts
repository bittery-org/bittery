import { describe, expect, it } from "bun:test";
import type { CachedVaultMetadata } from "@bittery/types";
import { type DeltaSyncApiClient, performDeltaSync } from "../delta-sync";
import type { SyncEvent, SyncItemCache, SyncVaultKeyEntry } from "../types";

function serverVault() {
	return {
		id: "vault_1",
		name: "Team Vault",
		vaultType: "team",
		icon: "lock",
		imageUrl: null,
	};
}

function client(): DeltaSyncApiClient {
	return {
		items: {
			get: async () => {
				throw new Error("not used");
			},
			listInVault: async () => ({ data: [] }),
		},
		vaults: {
			get: async () => ({ data: serverVault() }),
			list: async () => ({
				data: [
					{
						...serverVault(),
						encryptedVaultKey: "ZW5jcnlwdGVk",
						role: "owner",
					},
				],
			}),
		},
	} as unknown as DeltaSyncApiClient;
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
	const vaultKeys: SyncVaultKeyEntry[] = [];
	const vaults: CachedVaultMetadata[] = [];

	const cache: SyncItemCache = {
		syncVaultKeys: async (keys) => {
			vaultKeys.push(...keys);
		},
		upsertCachedVault: async (vault) => {
			vaults.push(vault);
		},
		upsertCachedItem: async () => undefined,
		removeCachedItem: async () => undefined,
		removeCachedVault: async () => undefined,
		clearItemCache: async () => undefined,
		replaceItemId: () => undefined,
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

		await performDeltaSync(client(), cache, event(), "acc_1");

		expect(vaultKeys).toHaveLength(1);
		expect(vaultKeys[0]?.vaultType).toBe("team");
		expect(vaultKeys[0]?.vaultId).toBe("vault_1");
		expect(vaultKeys[0]?.role).toBe("owner");
	});

	it("keeps the team type when caching vault metadata after a vault update", async () => {
		const { cache, vaults } = recordingCache();

		await performDeltaSync(
			client(),
			cache,
			event({ type: "vault_updated" }),
			"acc_1",
		);

		const cached = vaults.find((vault) => vault.id === "vault_1");
		expect(cached?.type).toBe("team");
	});

	it("still refreshes vault keys when a vault is created", async () => {
		const { cache, vaultKeys } = recordingCache();

		await performDeltaSync(
			client(),
			cache,
			event({ type: "vault_created" }),
			"acc_1",
		);

		expect(vaultKeys[0]?.vaultType).toBe("team");
	});
});
