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

export async function mergeDesktopAndLocalItemSources(
	desktopItemsPromise: Promise<MultiAccountItem[] | null>,
	localItemsPromise: Promise<MultiAccountItem[]>,
): Promise<MultiAccountItem[]> {
	const [desktopResult, localResult] = await Promise.allSettled([
		desktopItemsPromise,
		localItemsPromise,
	]);
	if (desktopResult.status === "rejected") {
		throw desktopResult.reason;
	}
	if (localResult.status === "fulfilled") {
		return mergeItemCollections(desktopResult.value ?? [], localResult.value);
	}
	if (!desktopResult.value) {
		throw localResult.reason;
	}

	const reason = localResult.reason;
	if (
		reason instanceof Error &&
		(reason.message.startsWith("No verified travel mode policy") ||
			reason.message.startsWith("Travel mode policy is not verified"))
	) {
		console.debug(
			"[vault-utils] Skipping extension-local items because its verified travel-mode policy is unavailable",
		);
	} else {
		console.warn(
			"[vault-utils] Local items unavailable during desktop-backed read; using the desktop snapshot:",
			reason,
		);
	}
	return desktopResult.value;
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

async function getDesktopItemsSnapshot(): Promise<MultiAccountItem[] | null> {
	const targetAccountIds = await getDesktopTargetAccountIds();
	if (targetAccountIds.length === 0) {
		return null;
	}

	const snapshot = await desktopClient.getItemsSnapshot(targetAccountIds);
	if (!snapshot) {
		console.warn("[vault-utils] desktop snapshot unavailable", {
			targetAccountIds,
		});
		return null;
	}

	const normalizedItems = snapshot.items
		.map((item) => parseDesktopSnapshotItem(item as Record<string, unknown>))
		.filter((item): item is MultiAccountItem => item !== null);

	// The desktop only exposes items whose vault keys survived its verified
	// travel-mode enforcement. Applying the extension's separate local policy
	// here can discard a valid snapshot after a service-worker restart, before
	// the extension has rebuilt its own policy cache.
	return normalizedItems;
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
			const mergedItems = await mergeDesktopAndLocalItemSources(
				getDesktopItemsSnapshot(),
				getLocalCoordinatorItems(),
			);
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
