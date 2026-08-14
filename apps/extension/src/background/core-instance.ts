import { createCoreContext } from "@bittery/core";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { toCachedItem } from "@bittery/shared/item-mapping";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "../lib/storage";
import { vaultCrypto, vaultRepository } from "../lib/vault-runtime";

export function createBackgroundCore(runtime: ClientRuntime) {
	return createCoreContext({
		storage,
		itemCache,
		crypto,
		vaultCrypto,
		vaultRuntime: runtime.vaultRuntime,
		commandQueue: {
			enqueue: async (command) => {
				const { enqueueOutboundCommand } = await import("./outbound-drain");
				await enqueueOutboundCommand(command);
			},
		},
		hydrateItem: async (accountId, itemId) => {
			const { syncCacheService } = await import(
				"./services/sync-cache-service"
			);
			const client = await syncCacheService.getClientForAccountId(accountId);
			if (!client) {
				throw new Error(`No authenticated client for account ${accountId}`);
			}
			const account = vaultRepository.getAccountInfo(accountId);
			const { data: item } = await client.items.get(itemId);
			await vaultRepository.upsertCachedItem(
				toCachedItem(item, {
					accountId,
					accountEmail: account?.email,
					serverUrl: account?.serverUrl,
				}),
				accountId,
			);
		},
	});
}
