/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import type { VaultRepositoryItemWithAccount } from "@bittery/core/services/vault-repository";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { itemCache, storage } from "../lib/storage";
import { vaultRepository } from "../lib/vault-runtime";
import { desktopClient } from "./desktop-client";
import { parseDesktopSnapshotItem } from "./desktop-snapshot";
import { isDesktopReadAvailable } from "./desktop-status";
import { reconcileClientRuntime } from "./vault-runtime";

type MultiAccountItem = VaultRepositoryItemWithAccount;

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
	if (activeAccount) {
		return [activeAccount];
	}

	return [];
}

async function filterItemsForTravelMode(
	items: MultiAccountItem[],
): Promise<MultiAccountItem[]> {
	const enforcer = getTravelModeEnforcer(storage, itemCache);
	const activeAccount = await storage.getActiveAccount();

	if (activeAccount) {
		await enforcer.hydrateFromStorage(activeAccount);
		return enforcer.filterItems(activeAccount, items);
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

async function getLocalRepositoryItems(
	runtime: ClientRuntime,
): Promise<MultiAccountItem[]> {
	try {
		await reconcileClientRuntime(runtime);
		const items = vaultRepository.getAll() as MultiAccountItem[];
		return filterItemsForTravelMode(items);
	} catch (error) {
		console.warn(
			"[vault-utils] Failed to load local repository items for desktop merge:",
			error,
		);
		const items = vaultRepository.getAll() as MultiAccountItem[];
		return filterItemsForTravelMode(items);
	}
}

/**
 * Never yields holes: every source here is a `MultiAccountItem[]`. The result
 * is typed accordingly so callers (and the `GET_VAULT_ITEMS` route) do not have
 * to defend against a null that cannot occur.
 */
export async function getDecryptedItemsForCurrentMode(
	runtime: ClientRuntime,
): Promise<DecryptedItemWithContext[]> {
	const desktopReadAvailable = await isDesktopReadAvailable();

	if (desktopReadAvailable) {
		try {
			const mergedItems = await mergeDesktopAndLocalItemSources(
				getDesktopItemsSnapshot(),
				getLocalRepositoryItems(runtime),
			);
			return mergedItems;
		} catch (error) {
			console.warn(
				"[vault-utils] Desktop snapshot read failed, falling back to local decryption:",
				error,
			);
		}
	}

	await reconcileClientRuntime(runtime);
	const localItems = vaultRepository.getAll() as MultiAccountItem[];
	return filterItemsForTravelMode(localItems);
}

import type { ClientRuntime } from "@bittery/core/services/client-runtime";
