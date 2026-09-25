import type {
	RuntimeSessionSnapshot,
	RuntimeSnapshot,
} from "@bittery/client-runtime/client";
import type {
	EditableItemDraft,
	ItemsProjection,
	PublicItemDraft,
	RuntimeErrorCode,
} from "@bittery/client-runtime/protocol";
import type {
	DecryptedItemData,
	ItemCategory,
	ItemContextMetadata,
	PublicDecryptedItemData,
} from "@bittery/shared/types";
import type { VaultRole } from "@bittery/shared/vault-mapping";
import type { VaultOption } from "../components/vault/types";

/** The existing Item presentation shape, derived from the generated projection's mapper. */
export type RuntimeListItem = ReturnType<
	typeof mapRuntimeItemsProjection
>[number] &
	ItemContextMetadata;

/** A Vault the Runtime knows, in the shape the existing item form already reads. */
export type RuntimeVaultOption = VaultOption & {
	/** This Account's membership, in the Server's own closed set. */
	readonly role: VaultRole;
	/** Whether this Device may write Items here. The Vault's role, not the create rule. */
	readonly writable: boolean;
	/** The Account the Vault belongs to, as the Runtime names it. */
	readonly accountId: string;
};

/**
 * One Vault as the nav sidebar renders it.
 *
 * The field names are the sidebar's, which grew around the transitional Vault-key record.
 * Renaming them is a UI change, not a cutover, so the mapping happens here instead.
 */
export interface VaultNavEntry {
	readonly vaultId: string;
	readonly vaultName: string;
	readonly vaultType: "personal" | "team";
	readonly vaultIcon: string | null;
	readonly vaultImageUrl: string | null;
	readonly role: VaultRole;
	readonly accountId: string;
}

const NO_ITEMS: RuntimeListItem[] = [];
const NO_VAULTS: RuntimeVaultOption[] = [];

/**
 * What the vault pages render. A boolean cannot hold this: "still loading", "locked",
 * "signed out", and "empty" all reached the old `isLoading: false` and came out as the
 * empty-vault state, which in a password manager reads as data loss.
 */
export type RuntimeItemsState =
	| "loading"
	| "ready"
	| "locked"
	| "signedOut"
	| "missing"
	| "unavailable";

export interface RuntimeItemsView {
	/** Active Items for ordinary lists, counts, tags and security views. */
	readonly items: RuntimeListItem[];
	/** Deleted Items remain available only to the Trash presentation. */
	readonly trashedItems: RuntimeListItem[];
	/** The Account these Items belong to, as the Runtime itself names it. */
	readonly accountId: string | null;
	/**
	 * The Vaults behind those Items. The Runtime is the only reader that still knows them
	 * after a Runtime Sign-in, so a page asking a transitional source would see none.
	 */
	readonly vaults: readonly RuntimeVaultOption[];
	readonly state: RuntimeItemsState;
	/** The semantic code behind an unavailable list. Never the Rust diagnostic text. */
	readonly code: RuntimeErrorCode | null;
}

/**
 * Folds the Device session and the Items observation into one answer.
 *
 * The session decides first: an Account that is locked has Items, and saying so is the
 * difference between a lock screen and an empty list. Only an unlocked Account gets as far
 * as reading the observation, and an observation that answers `AUTHENTICATION_REQUIRED`
 * means the Account locked underneath it — a lock, not a failure.
 */
export function deriveRuntimeItemsView(
	session: RuntimeSessionSnapshot,
	items: RuntimeSnapshot<ItemsProjection>,
): RuntimeItemsView {
	if (session.state !== "unlocked") {
		return {
			items: NO_ITEMS,
			trashedItems: NO_ITEMS,
			accountId: null,
			vaults: NO_VAULTS,
			state: session.state === "loading" ? "loading" : session.state,
			code: session.code,
		};
	}
	if (items.state === "ready") {
		const mapped = mapRuntimeItemsProjection(items.value);
		return {
			items: mapped.filter((item) => item.deletedAt == null),
			trashedItems: mapped.filter((item) => item.deletedAt != null),
			accountId: items.value.accountId,
			vaults: mapRuntimeVaults(items.value),
			state: "ready",
			code: null,
		};
	}
	if (items.state === "failed") {
		return {
			items: NO_ITEMS,
			trashedItems: NO_ITEMS,
			accountId: null,
			vaults: NO_VAULTS,
			state:
				items.code === "AUTHENTICATION_REQUIRED" ? "locked" : "unavailable",
			code: items.code,
		};
	}
	return {
		items: NO_ITEMS,
		trashedItems: NO_ITEMS,
		accountId: null,
		vaults: NO_VAULTS,
		state: "loading",
		code: null,
	};
}

/**
 * Maps a Runtime Items projection onto the existing list shape. Filter, sort, and render
 * stay in the host ItemList.
 *
 * Host form/list adaptation lives above the Runtime protocol. The returned presentation type
 * is inferred here, so UI reuse does not import a legacy repository or invent another protocol.
 */
export function mapRuntimeItemsProjection(projection: ItemsProjection) {
	const vaults = new Map(
		projection.vaults.map((vault) => [vault.vaultId, vault]),
	);
	return projection.items.map((item) => ({
		id: item.itemId,
		accountId: item.accountId,
		vaultId: item.vaultId,
		...toHostItemData(item.data.data),
		urls: "urls" in item.data.data ? (item.data.data.urls ?? []) : [],
		tags: item.data.data.tags ?? [],
		category: hostItemCategory(item.data.category),
		favorite: item.favorite === true,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		// The Runtime's own word about this Item, carried beside the repository shape rather
		// than folded into `optimisticFailure`, which would need an `operationId` and a
		// rejection code this projection does not carry and must not invent.
		runtimeStatus: item.status,
		deletedAt: item.deletedAt ?? null,
		version: 1,
		lastModifiedBy: "",
		encryptionVersion: 1,
		encryptedByUserId: "",
		_encrypted: {
			data: "",
			iv: "",
			algorithm: "",
		},
		attachments: item.attachments?.map((attachment) => ({
			id: attachment.attachmentId,
			accountId: attachment.accountId,
			itemId: attachment.itemId,
			vaultId: attachment.vaultId,
			name: attachment.name,
			contentType: attachment.contentType,
			fileSize: attachment.fileSize,
			uploadedBy: attachment.uploadedBy,
			createdAt: attachment.createdAt,
		})),
		// The Runtime names the Vault in the same projection, so the dashboard, the
		// security report and the list all read one source. An Item whose Vault the
		// projection does not carry keeps an empty name rather than borrowing another
		// Vault's: a wrong Vault label in a password manager is worse than none.
		vault: {
			id: item.vaultId,
			name: vaults.get(item.vaultId)?.name ?? "",
			type: vaults.get(item.vaultId)?.vaultType ?? "personal",
			icon: vaults.get(item.vaultId)?.icon ?? null,
			imageUrl: vaults.get(item.vaultId)?.imageUrl ?? null,
		},
	}));
}

/** Keep host category spelling checked against both closed type definitions. */
function hostItemCategory(category: PublicItemDraft["category"]): ItemCategory {
	return category === "authenticator" ? "totp" : category;
}

/** The generated protocol uses null for absent optional fields; host forms use undefined. */
function toHostItemData(
	data: ItemsProjection["items"][number]["data"]["data"],
): PublicDecryptedItemData {
	function optionalFields(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(optionalFields);
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, entry]) => entry !== null)
					.map(([key, entry]) => [key, optionalFields(entry)]),
			);
		return value;
	}
	return optionalFields(data) as PublicDecryptedItemData;
}

/** The Vaults of one projection, in the shape the existing item form reads. */
export function mapRuntimeVaults(
	projection: ItemsProjection,
): RuntimeVaultOption[] {
	return projection.vaults.map((vault) => ({
		id: vault.vaultId,
		name: vault.name,
		type: vault.vaultType,
		icon: vault.icon ?? null,
		imageUrl: vault.imageUrl ?? null,
		role: vault.role,
		// Every role but read-only may write an Item. The Runtime publishes the role and
		// the host asks its own question of it, so "may I write here" is answered once.
		writable: vault.role !== "read-only",
		accountId: projection.accountId,
	}));
}

/** One Vault by id, or `null` when this Account does not hold it. Never a guess. */
export function findRuntimeVault(
	vaults: readonly RuntimeVaultOption[],
	vaultId: string,
): RuntimeVaultOption | null {
	return vaults.find((vault) => vault.id === vaultId) ?? null;
}

/** The Vaults the nav sidebar renders, in the field names it already reads. */
export function vaultNavEntries(
	vaults: readonly RuntimeVaultOption[],
): VaultNavEntry[] {
	return vaults.map((vault) => ({
		vaultId: vault.id,
		vaultName: vault.name,
		vaultType: vault.type,
		vaultIcon: vault.icon ?? null,
		vaultImageUrl: vault.imageUrl ?? null,
		role: vault.role,
		accountId: vault.accountId,
	}));
}

/** Writable Runtime Vaults offered by the Item forms. */
export function creatableVaults(
	vaults: readonly RuntimeVaultOption[],
): RuntimeVaultOption[] {
	return vaults.filter((vault) => vault.writable);
}

/** Whether this Device may write the Items of one Vault. An unknown Vault may not. */
export function canWriteVault(
	vaults: readonly RuntimeVaultOption[],
	vaultId: string,
): boolean {
	return vaults.some((vault) => vault.id === vaultId && vault.writable);
}

/** Preserve category data at the generated Runtime boundary. */
export function toRuntimeItemDraft(
	category: ItemCategory,
	data: DecryptedItemData,
): EditableItemDraft {
	if (category === "login") {
		const { passkeys, ...editable } = data;
		if (passkeys && passkeys.length > 0)
			throw new Error("Use the credential import to add passkeys");
		return { category, data: editable } as EditableItemDraft;
	}
	if (category === "secure-note")
		return { category, data: { ...data, note: data.note ?? "" } };
	if (category === "totp")
		return {
			category: "authenticator",
			data: { ...data, totpSecret: data.totpSecret ?? "" },
		};
	return { category, data } as EditableItemDraft;
}
