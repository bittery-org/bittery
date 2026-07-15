/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import type { MultiAccountItem } from "@bittery/core/services/item-service";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import type {
	DecryptedItemWithContext,
	ItemCategory,
	Passkey,
} from "@bittery/shared/types";
import { storage } from "../lib/storage";
import { core } from "./core-instance";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

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

function isItemCategory(value: unknown): value is ItemCategory {
	return (
		value === "login" ||
		value === "secure-note" ||
		value === "credit-card" ||
		value === "identity" ||
		value === "totp"
	);
}

function isPasskey(value: unknown): value is Passkey {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<Passkey>;
	return (
		typeof candidate.credentialId === "string" &&
		typeof candidate.rpId === "string" &&
		typeof candidate.rpName === "string" &&
		typeof candidate.userHandle === "string" &&
		typeof candidate.userName === "string" &&
		typeof candidate.userDisplayName === "string" &&
		typeof candidate.privateKey === "string" &&
		typeof candidate.publicKey === "string" &&
		typeof candidate.algorithm === "number" &&
		typeof candidate.signCount === "number" &&
		Array.isArray(candidate.transports) &&
		candidate.transports.every((transport) => typeof transport === "string") &&
		typeof candidate.createdAt === "string"
	);
}

export function normalizeDesktopSnapshotItem(
	item: Record<string, unknown>,
): MultiAccountItem | null {
	if (typeof item.id !== "string" || typeof item.vaultId !== "string") {
		return null;
	}

	const vault = item.vault as Record<string, unknown> | null | undefined;
	if (
		typeof vault !== "object" ||
		vault === null ||
		typeof vault.id !== "string" ||
		typeof vault.name !== "string" ||
		typeof vault.type !== "string"
	) {
		return null;
	}

	if (!isItemCategory(item.category)) {
		return null;
	}

	if (typeof item.title !== "string") {
		return null;
	}

	const normalized: MultiAccountItem = {
		id: item.id,
		vaultId: item.vaultId,
		category: item.category,
		favorite: Boolean(item.favorite),
		createdAt:
			typeof item.createdAt === "string"
				? item.createdAt
				: String(item.createdAt ?? ""),
		updatedAt:
			typeof item.updatedAt === "string"
				? item.updatedAt
				: String(item.updatedAt ?? ""),
		title: item.title,
		url: typeof item.url === "string" ? item.url : undefined,
		urls: Array.isArray(item.urls)
			? item.urls.filter((value): value is string => typeof value === "string")
			: undefined,
		username: typeof item.username === "string" ? item.username : undefined,
		password: typeof item.password === "string" ? item.password : undefined,
		passkeys: Array.isArray(item.passkeys)
			? item.passkeys.filter(isPasskey)
			: undefined,
		notes: typeof item.notes === "string" ? item.notes : undefined,
		note: typeof item.note === "string" ? item.note : undefined,
		tags: Array.isArray(item.tags)
			? item.tags.filter((value): value is string => typeof value === "string")
			: undefined,
		totpSecret:
			typeof item.totpSecret === "string" ? item.totpSecret : undefined,
		totpIssuer:
			typeof item.totpIssuer === "string" ? item.totpIssuer : undefined,
		totpAccountName:
			typeof item.totpAccountName === "string"
				? item.totpAccountName
				: undefined,
		vault: {
			id: vault.id,
			name: vault.name,
			type: vault.type,
			icon: typeof vault.icon === "string" ? vault.icon : null,
			imageUrl: typeof vault.imageUrl === "string" ? vault.imageUrl : null,
		},
	};

	return normalized;
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
		.map((item) =>
			normalizeDesktopSnapshotItem(item as Record<string, unknown>),
		)
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
	const desktopStatus =
		desktopSync.getLastStatus() ?? (await desktopSync.checkDesktopStatus());
	const desktopReadAvailable = Boolean(
		desktopStatus?.available && !desktopStatus.locked,
	);

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

export function getBaseDomain(host: string): string {
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

export function hostnameMatches(
	itemUrl: string,
	targetHostname: string,
): boolean {
	if (!itemUrl) return false;

	try {
		const itemUrlObj = new URL(
			itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`,
		);
		const itemHostname = itemUrlObj.hostname;

		if (itemHostname === targetHostname) return true;

		if (
			itemHostname.endsWith(`.${targetHostname}`) ||
			targetHostname.endsWith(`.${itemHostname}`)
		) {
			return true;
		}

		const itemBaseDomain = getBaseDomain(itemHostname);
		const hostnameBaseDomain = getBaseDomain(targetHostname);

		return itemBaseDomain === hostnameBaseDomain;
	} catch {
		return false;
	}
}
