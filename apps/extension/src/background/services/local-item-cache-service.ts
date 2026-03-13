/**
 * Local Item Cache Service
 *
 * Centralizes repository writes performed by local background mutations
 * (credential save/update, TOTP updates, etc.) so local-first state and
 * desktop bridge invalidation stay consistent.
 */

import type { CachedEncryptedItem } from "@bittery/types";
import { core } from "../core-instance";
import { desktopClient } from "../desktop-client";

interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

interface LocalItemCreatedInput {
	itemId: string;
	vaultId: string;
	category: string;
	encryptedData: EncryptedPayload;
	accountEmail?: string;
}

interface LocalItemUpdatedInput {
	itemId: string;
	encryptedData: EncryptedPayload;
	accountEmail?: string;
}

interface LegacyLocalCache {
	onItemCreated: (input: LocalItemCreatedInput) => Promise<void>;
	onItemUpdated: (input: LocalItemUpdatedInput) => Promise<void>;
}

interface LocalItemCacheServiceDeps {
	vaultCoordinator?: typeof core.vaultCoordinator;
	cache?: LegacyLocalCache;
	desktopClient: {
		clearCache: () => void;
	};
}

const defaultDeps: LocalItemCacheServiceDeps = {
	vaultCoordinator: core.vaultCoordinator,
	desktopClient,
};

export function createLocalItemCacheService(
	inputDeps: LocalItemCacheServiceDeps = defaultDeps,
) {
	const deps: LocalItemCacheServiceDeps = {
		...defaultDeps,
		...inputDeps,
	};

	return {
		async onLocalItemCreated(input: LocalItemCreatedInput): Promise<void> {
			if (deps.cache) {
				await deps.cache.onItemCreated(input);
				deps.desktopClient.clearCache();
				return;
			}

			const vaultCoordinator = deps.vaultCoordinator;
			if (!vaultCoordinator) {
				return;
			}

			const accountEmail = input.accountEmail;
			if (!accountEmail) {
				return;
			}
			const repo = vaultCoordinator.getRepositoryForEmail(accountEmail);
			const now = new Date().toISOString();
			const item: CachedEncryptedItem = {
				id: input.itemId,
				vaultId: input.vaultId,
				accountEmail,
				serverUrl: repo.getServerUrl(),
				category: input.category,
				favorite: false,
				encryptedData: input.encryptedData.ciphertext,
				encryptionIv: input.encryptedData.iv,
				encryptionAlgorithm: input.encryptedData.algorithm,
				version: 1,
				lastModifiedBy: null,
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
			};
			await vaultCoordinator.upsertEncrypted(item, accountEmail);
			deps.desktopClient.clearCache();
		},

		async onLocalItemUpdated(input: LocalItemUpdatedInput): Promise<void> {
			if (deps.cache) {
				await deps.cache.onItemUpdated(input);
				deps.desktopClient.clearCache();
				return;
			}

			const vaultCoordinator = deps.vaultCoordinator;
			if (!vaultCoordinator) {
				return;
			}

			const resolvedAccount = input.accountEmail
				? {
						email: input.accountEmail,
						repo: vaultCoordinator.getRepositoryForEmail(input.accountEmail),
					}
				: existingItemAccount(vaultCoordinator, input.itemId);
			if (!resolvedAccount) {
				return;
			}
			const existing = resolvedAccount.repo.getById(input.itemId);
			if (!existing) {
				return;
			}
			const item: CachedEncryptedItem = {
				id: existing.id,
				vaultId: existing.vaultId,
				accountEmail: existing.accountEmail ?? resolvedAccount.email,
				serverUrl: existing.serverUrl ?? resolvedAccount.repo.getServerUrl(),
				category: existing.category,
				favorite: existing.favorite,
				encryptedData: input.encryptedData.ciphertext,
				encryptionIv: input.encryptedData.iv,
				encryptionAlgorithm: input.encryptedData.algorithm,
				version: existing.version + 1,
				lastModifiedBy: existing.lastModifiedBy,
				createdAt: existing.createdAt,
				updatedAt: new Date().toISOString(),
				deletedAt: existing.deletedAt,
				attachments: existing.attachments,
			};
			await vaultCoordinator.upsertEncrypted(item, resolvedAccount.email);
			deps.desktopClient.clearCache();
		},
	};
}

function existingItemAccount(
	vaultCoordinator: NonNullable<LocalItemCacheServiceDeps["vaultCoordinator"]>,
	itemId: string,
) {
	const item = vaultCoordinator.getById(itemId);
	if (item?.accountEmail) {
		return {
			email: item.accountEmail,
			repo: vaultCoordinator.getRepositoryForEmail(item.accountEmail),
		};
	}
	return undefined;
}

const localItemCacheService = createLocalItemCacheService();

export async function onLocalItemCreated(
	input: LocalItemCreatedInput,
): Promise<void> {
	await localItemCacheService.onLocalItemCreated(input);
}

export async function onLocalItemUpdated(
	input: LocalItemUpdatedInput,
): Promise<void> {
	await localItemCacheService.onLocalItemUpdated(input);
}
