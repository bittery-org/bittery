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

interface LocalItemCacheServiceDeps {
	vaultCoordinator: typeof core.vaultCoordinator;
	desktopClient: {
		clearCache: () => void;
	};
}

const defaultDeps: LocalItemCacheServiceDeps = {
	vaultCoordinator: core.vaultCoordinator,
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
			const accountEmail =
				input.accountEmail ??
				deps.vaultCoordinator.findAccountForVault(input.vaultId)?.email;
			if (!accountEmail) {
				return;
			}
			const now = new Date().toISOString();
			const item: CachedEncryptedItem = {
				id: input.itemId,
				vaultId: input.vaultId,
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
			await deps.vaultCoordinator.upsertEncrypted(item, accountEmail);
			deps.desktopClient.clearCache();
		},

		async onLocalItemUpdated(input: {
			itemId: string;
			encryptedData: EncryptedPayload;
			accountEmail?: string;
		}): Promise<void> {
			const resolvedAccount = input.accountEmail
				? {
						email: input.accountEmail,
						repo: deps.vaultCoordinator.getRepositoryForEmail(
							input.accountEmail,
						),
					}
				: deps.vaultCoordinator.findAccountForItem(input.itemId);
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
			await deps.vaultCoordinator.upsertEncrypted(item, resolvedAccount.email);
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
