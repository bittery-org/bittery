/**
 * Local Item Cache Service
 *
 * Centralizes repository writes performed by local background mutations
 * (credential save/update, TOTP updates, etc.) so local-first state and
 * desktop bridge invalidation stay consistent.
 */

import {
	toCachedItemMetadata,
	toEncryptedPayload,
	toNewCachedItem,
	withEncryptedPayload,
} from "@bittery/shared/item-mapping";
import type { CachedEncryptedItem } from "@bittery/types";
import { core } from "../core-instance";
import { desktopClient } from "../desktop-client";

interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
	encryptionVersion: number;
	encryptedByUserId: string;
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

interface LocalItemCacheServiceDeps {
	vaultCoordinator?: typeof core.vaultCoordinator;
	desktopClient: {
		clearCache: () => void;
	};
}

const defaultDeps: LocalItemCacheServiceDeps = {
	vaultCoordinator: core.vaultCoordinator,
	desktopClient,
};

function resolveAccountFromEmail(
	vaultCoordinator: NonNullable<LocalItemCacheServiceDeps["vaultCoordinator"]>,
	accountEmail: string,
) {
	const accountId = vaultCoordinator.resolveAccountIdByEmail(accountEmail);
	if (!accountId) {
		return undefined;
	}
	return {
		accountId,
		email: accountEmail,
		repo: vaultCoordinator.getRepositoryForAccount(accountId),
	};
}

export function createLocalItemCacheService(
	inputDeps: LocalItemCacheServiceDeps = defaultDeps,
) {
	const deps: LocalItemCacheServiceDeps = {
		...defaultDeps,
		...inputDeps,
	};

	return {
		async onLocalItemCreated(input: LocalItemCreatedInput): Promise<void> {
			const vaultCoordinator = deps.vaultCoordinator;
			if (!vaultCoordinator) {
				return;
			}

			const accountEmail = input.accountEmail;
			if (!accountEmail) {
				return;
			}
			const resolvedAccount = resolveAccountFromEmail(
				vaultCoordinator,
				accountEmail,
			);
			if (!resolvedAccount) {
				return;
			}
			const repo = resolvedAccount.repo;
			const item = toNewCachedItem(
				{
					id: input.itemId,
					vaultId: input.vaultId,
					category: input.category,
					timestamp: new Date().toISOString(),
					// The server's INSERT lands a create at version 1, whatever the ciphertext
					// was bound to.
					version: 1,
					payload: toEncryptedPayload(input.encryptedData),
				},
				{ accountEmail, serverUrl: repo.getServerUrl() },
			);
			await vaultCoordinator.upsertCachedItem(item, resolvedAccount.accountId);
			deps.desktopClient.clearCache();
		},

		async onLocalItemUpdated(input: LocalItemUpdatedInput): Promise<void> {
			const vaultCoordinator = deps.vaultCoordinator;
			if (!vaultCoordinator) {
				return;
			}

			const resolvedAccount = input.accountEmail
				? resolveAccountFromEmail(vaultCoordinator, input.accountEmail)
				: existingItemAccount(vaultCoordinator, input.itemId);
			if (!resolvedAccount) {
				return;
			}
			const existing = resolvedAccount.repo.getById(input.itemId);
			if (!existing) {
				return;
			}
			const item: CachedEncryptedItem = withEncryptedPayload(
				toCachedItemMetadata(existing, {
					accountEmail: resolvedAccount.email,
					serverUrl: resolvedAccount.repo.getServerUrl(),
				}),
				toEncryptedPayload(input.encryptedData),
				{
					// Distinct fields that coincide here: the caller bound this ciphertext to the base
					// version + 1, which is the version the server write lands on. They diverge in
					// general — favourite/trash/restore and key rotation advance `version` alone.
					version: input.encryptedData.encryptionVersion,
					updatedAt: new Date().toISOString(),
				},
			);
			await vaultCoordinator.upsertCachedItem(item, resolvedAccount.accountId);
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
		return resolveAccountFromEmail(vaultCoordinator, item.accountEmail);
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
