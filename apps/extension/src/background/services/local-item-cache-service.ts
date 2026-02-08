/**
 * Local Item Cache Service
 *
 * Centralizes cache writes performed by local background mutations
 * (credential save/update, TOTP updates, etc.) so cache and desktop bridge
 * invalidation stay consistent.
 */

import { core } from "../core-instance";
import { desktopClient } from "../desktop-client";

interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

type CacheWriter = {
	onItemCreated: (input: {
		itemId: string;
		vaultId: string;
		category: string;
		encryptedData: EncryptedPayload;
		accountEmail?: string;
	}) => Promise<void>;
	onItemUpdated: (input: {
		itemId: string;
		encryptedData: EncryptedPayload;
		accountEmail?: string;
	}) => Promise<void>;
};

interface LocalItemCacheServiceDeps {
	cache: CacheWriter;
	desktopClient: {
		clearCache: () => void;
	};
}

const defaultDeps: LocalItemCacheServiceDeps = {
	cache: core.cache,
	desktopClient,
};

export function createLocalItemCacheService(
	deps: LocalItemCacheServiceDeps = defaultDeps,
) {
	return {
		async onLocalItemCreated(input: {
			itemId: string;
			vaultId: string;
			category: string;
			encryptedData: EncryptedPayload;
			accountEmail?: string;
		}): Promise<void> {
			await deps.cache.onItemCreated(input);
			deps.desktopClient.clearCache();
		},

		async onLocalItemUpdated(input: {
			itemId: string;
			encryptedData: EncryptedPayload;
			accountEmail?: string;
		}): Promise<void> {
			await deps.cache.onItemUpdated(input);
			deps.desktopClient.clearCache();
		},
	};
}

const localItemCacheService = createLocalItemCacheService();

export async function onLocalItemCreated(input: {
	itemId: string;
	vaultId: string;
	category: string;
	encryptedData: EncryptedPayload;
	accountEmail?: string;
}): Promise<void> {
	await localItemCacheService.onLocalItemCreated(input);
}

export async function onLocalItemUpdated(input: {
	itemId: string;
	encryptedData: EncryptedPayload;
	accountEmail?: string;
}): Promise<void> {
	await localItemCacheService.onLocalItemUpdated(input);
}
