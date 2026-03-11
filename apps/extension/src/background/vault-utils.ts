/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import type { DecryptedItem, ItemCategory, Passkey } from "@bittery/shared/types";
import { storage } from "../lib/storage";
import { core } from "./core-instance";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

type MultiAccountItem = DecryptedItem & {
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
	account?: {
		email: string;
		userId: string;
		name: string;
	};
};

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
	includeAccountContext: boolean,
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
		username:
			typeof item.username === "string" ? item.username : undefined,
		password:
			typeof item.password === "string" ? item.password : undefined,
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

	if (includeAccountContext) {
		const account = item.account as Record<string, unknown> | null | undefined;
		if (
			typeof account === "object" &&
			account !== null &&
			typeof account.email === "string"
		) {
			normalized.account = {
				email: account.email,
				userId: typeof account.userId === "string" ? account.userId : "",
				name:
					typeof account.name === "string" ? account.name : account.email,
			};
		}
	}

	return normalized;
}

async function getDesktopTargetEmails(): Promise<string[]> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return [activeAccount.email.toLowerCase()];
	}

	const statusEmails = desktopSync
		.getLastStatus()
		?.unlockedAccounts?.map((email) => email.toLowerCase());
	if (statusEmails && statusEmails.length > 0) {
		return Array.from(new Set(statusEmails));
	}

	const accounts = await desktopClient.getAccounts();
	if (!accounts) {
		return [];
	}

	return Array.from(
		new Set(accounts.unlockedAccounts.map((email) => email.toLowerCase())),
	);
}

async function getDesktopItemsSnapshot(): Promise<MultiAccountItem[]> {
	const activeAccount = await storage.getActiveAccount();
	const targetEmails = await getDesktopTargetEmails();
	if (targetEmails.length === 0) {
		console.info("[vault-utils] desktop snapshot skipped: no target emails");
		return [];
	}

	const includeAccountContext = activeAccount?.type === "all";
	const snapshot = await desktopClient.getItemsSnapshot(targetEmails);
	if (!snapshot) {
		console.warn("[vault-utils] desktop snapshot unavailable", {
			targetEmails,
		});
		return [];
	}

	const normalizedItems = snapshot.items
		.map((item) =>
			normalizeDesktopSnapshotItem(
				item as Record<string, unknown>,
				includeAccountContext,
			),
		)
		.filter((item): item is MultiAccountItem => item !== null);

	console.info("[vault-utils] desktop snapshot loaded", {
		targetEmails,
		includeAccountContext,
		rawCount: snapshot.items.length,
		normalizedCount: normalizedItems.length,
	});

	return normalizedItems;
}

async function getLocalCoordinatorItems(): Promise<MultiAccountItem[]> {
	try {
		const { accountsInfo } = await core.accounts.resolveAccounts();
		core.vaultCoordinator.setActiveAccounts(accountsInfo);
		const items = core.vaultCoordinator.getAll() as MultiAccountItem[];
		console.info("[vault-utils] local coordinator items loaded", {
			accountCount: accountsInfo.length,
			itemCount: items.length,
		});
		return items;
	} catch (error) {
		console.warn(
			"[vault-utils] Failed to load local coordinator items for desktop merge:",
			error,
		);
		const items = core.vaultCoordinator.getAll() as MultiAccountItem[];
		console.info("[vault-utils] local coordinator fallback snapshot", {
			itemCount: items.length,
		});
		return items;
	}
}

/**
 * Get decrypted items for current runtime mode.
 * Uses desktop snapshots in desktop mode and falls back to core/local decryption.
 */
export async function getDecryptedItemsForCurrentMode(): Promise<
	Array<DecryptedItem | null>
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
			console.info("[vault-utils] desktop/local merge complete", {
				desktopReadAvailable,
				desktopCount: desktopItems.length,
				localCount: localItems.length,
				mergedCount: mergedItems.length,
			});
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
	const localItems = core.vaultCoordinator.getAll();
	console.info("[vault-utils] local-only item load complete", {
		accountCount: accountsInfo.length,
		itemCount: localItems.length,
	});
	return localItems;
}

/**
 * Helper function to get base domain from hostname
 */
export function getBaseDomain(host: string): string {
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

/**
 * Helper function to check if hostname matches
 */
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
