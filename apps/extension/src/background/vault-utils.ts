/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import type { MultiAccountItem } from "@bittery/core/services/item-service";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { storage } from "../lib/storage";
import { core } from "./core-instance";
import { desktopClient } from "./desktop-client";
import { parseDesktopSnapshotItem } from "./desktop-snapshot";
import { isDesktopReadAvailable } from "./desktop-status";

export function mergeItemCollections(
	desktopItems: MultiAccountItem[],
	localItems: MultiAccountItem[],
): MultiAccountItem[] {
	const merged = new Map<string, MultiAccountItem>();

	for (const item of desktopItems) {
		merged.set(item.id, item);
	}

	for (const item of localItems) {
		merged.set(item.id, item);
	}

	return Array.from(merged.values());
}

async function getDesktopTargetAccountIds(): Promise<string[]> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return [activeAccount.accountId];
	}

	return [];
}

async function filterItemsForTravelMode(
	items: MultiAccountItem[],
): Promise<MultiAccountItem[]> {
	const enforcer = getTravelModeEnforcer(storage);
	const activeAccount = await storage.getActiveAccount();

	if (activeAccount?.type === "single") {
		await enforcer.hydrateFromStorage(activeAccount.accountId);
		return enforcer.filterItems(activeAccount.accountId, items);
	}

	// No single active account means we cannot determine which account's travel
	// rules apply. Fail closed and surface nothing rather than leaking items that
	// may be blocked by travel mode.
	return [];
}

async function getDesktopItemsSnapshot(): Promise<MultiAccountItem[]> {
	const targetAccountIds = await getDesktopTargetAccountIds();
	if (targetAccountIds.length === 0) {
		return [];
	}

	const snapshot = await desktopClient.getItemsSnapshot(targetAccountIds);
	if (!snapshot) {
		console.warn("[vault-utils] desktop snapshot unavailable", {
			targetAccountIds,
		});
		return [];
	}

	const normalizedItems = snapshot.items
		.map((item) => parseDesktopSnapshotItem(item as Record<string, unknown>))
		.filter((item): item is MultiAccountItem => item !== null);

	return filterItemsForTravelMode(normalizedItems);
}

async function getLocalCoordinatorItems(): Promise<MultiAccountItem[]> {
	try {
		const { accountsInfo } = await core.accounts.resolveAccounts();
		core.vaultCoordinator.setActiveAccounts(accountsInfo);
		const items = core.vaultCoordinator.getAll() as MultiAccountItem[];
		return filterItemsForTravelMode(items);
	} catch (error) {
		console.warn(
			"[vault-utils] Failed to load local coordinator items for desktop merge:",
			error,
		);
		const items = core.vaultCoordinator.getAll() as MultiAccountItem[];
		return filterItemsForTravelMode(items);
	}
}

export async function getDecryptedItemsForCurrentMode(): Promise<
	Array<DecryptedItemWithContext | null>
> {
	const desktopReadAvailable = await isDesktopReadAvailable();

	if (desktopReadAvailable) {
		try {
			const [desktopItems, localItems] = await Promise.all([
				getDesktopItemsSnapshot(),
				getLocalCoordinatorItems(),
			]);
			const mergedItems = mergeItemCollections(desktopItems, localItems);
			return mergedItems;
		} catch (error) {
			console.warn(
				"[vault-utils] Desktop snapshot read failed, falling back to local decryption:",
				error,
			);
		}
	}

	const { accountsInfo } = await core.accounts.resolveAccounts();
	await core.vaultCoordinator.hydrate(accountsInfo);
	const localItems = core.vaultCoordinator.getAll() as MultiAccountItem[];
	return filterItemsForTravelMode(localItems);
}
