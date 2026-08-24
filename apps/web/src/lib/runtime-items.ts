import type {
	RuntimeSessionSnapshot,
	RuntimeSnapshot,
} from "@bittery/client-runtime/client";
import type {
	ItemProjectionStatus,
	ItemsProjection,
	LoginItemDraft,
	RuntimeErrorCode,
} from "@bittery/client-runtime/protocol";
import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { VaultOption } from "@bittery/ui";

/**
 * A list Item plus what the Runtime says about it.
 *
 * `UnifiedItem` is the transitional repository shape and has nowhere honest to put a write
 * that has not landed yet, so the status rides alongside it instead of being squeezed into a
 * field that means something else. Ticket 22 replaces the whole shape.
 */
export type RuntimeListItem = UnifiedItem & {
	readonly runtimeStatus: ItemProjectionStatus;
};

/** A Vault the Runtime knows, in the shape the existing item form already reads. */
export type RuntimeVaultOption = VaultOption & {
	/** Whether this Device may write Items here. The Vault's role, not the create rule. */
	readonly writable: boolean;
};

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
	readonly items: RuntimeListItem[];
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
			accountId: null,
			vaults: NO_VAULTS,
			state: session.state === "loading" ? "loading" : session.state,
			code: session.code,
		};
	}
	if (items.state === "ready") {
		return {
			items: mapRuntimeItemsProjection(items.value),
			accountId: items.value.accountId,
			vaults: mapRuntimeVaults(items.value.vaults),
			state: "ready",
			code: null,
		};
	}
	if (items.state === "failed") {
		return {
			items: NO_ITEMS,
			accountId: null,
			vaults: NO_VAULTS,
			state:
				items.code === "AUTHENTICATION_REQUIRED" ? "locked" : "unavailable",
			code: items.code,
		};
	}
	return {
		items: NO_ITEMS,
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
 * This adapter lives in the app, not in `@bittery/client-runtime`: `UnifiedItem` is the
 * legacy repository shape ticket 22 deletes, and a compatibility mapper for a dying type
 * must not enter the shared package.
 */
export function mapRuntimeItemsProjection(
	projection: ItemsProjection,
): RuntimeListItem[] {
	return projection.items.map((item) => ({
		id: item.itemId,
		accountId: item.accountId,
		vaultId: item.vaultId,
		title: item.title,
		url: item.url ?? undefined,
		urls: item.urls ?? [],
		username: item.username ?? undefined,
		password: item.password ?? undefined,
		notes: item.notes ?? undefined,
		note: item.note ?? undefined,
		customFields: item.customFields ?? undefined,
		tags: item.tags ?? [],
		category: "login",
		favorite: item.favorite === true,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		// The Runtime's own word about this Item, carried beside the repository shape rather
		// than folded into `optimisticFailure`, which would need an `operationId` and a
		// rejection code this projection does not carry and must not invent.
		runtimeStatus: item.status,
		deletedAt: null,
		version: 1,
		lastModifiedBy: "",
		encryptionVersion: 1,
		encryptedByUserId: "",
		_encrypted: {
			data: "",
			iv: "",
			algorithm: "",
		},
		vault: {
			id: item.vaultId,
			name: "",
			type: "personal",
			icon: null,
			imageUrl: null,
		},
	}));
}

/** The Vaults of one projection, in the shape the existing item form reads. */
export function mapRuntimeVaults(
	vaults: ItemsProjection["vaults"],
): RuntimeVaultOption[] {
	return vaults.map((vault) => ({
		id: vault.vaultId,
		name: vault.name,
		type: vault.vaultType,
		icon: vault.icon ?? null,
		imageUrl: vault.imageUrl ?? null,
		writable: vault.writable,
	}));
}

/**
 * The Vaults a create may be offered for.
 *
 * The Runtime's first create slice writes one Login Item into a writable personal Vault and
 * refuses anything else, so offering more would be offering a refusal.
 */
export function creatableVaults(
	vaults: readonly RuntimeVaultOption[],
): RuntimeVaultOption[] {
	return vaults.filter((vault) => vault.writable && vault.type === "personal");
}

/** Whether this Device may write the Items of one Vault. An unknown Vault may not. */
export function canWriteVault(
	vaults: readonly RuntimeVaultOption[],
	vaultId: string,
): boolean {
	return vaults.some((vault) => vault.id === vaultId && vault.writable);
}

/**
 * Everything a Login form can collect that the Runtime's Login draft does not model yet.
 *
 * Named rather than dropped: silently discarding a TOTP secret the user just typed is data
 * loss, and the create path refuses instead.
 */
const UNSUPPORTED_DRAFT_FIELDS = [
	"passwordHistory",
	"passkeys",
	"cardholderName",
	"cardNumber",
	"cvv",
	"expiryDate",
	"billingAddress",
	"firstName",
	"middleName",
	"lastName",
	"email",
	"addresses",
	"phoneNumbers",
	"ssn",
	"passportNumber",
	"driversLicense",
	"dateOfBirth",
	"totpSecret",
	"totpIssuer",
	"totpAccountName",
	"totpAlgorithm",
	"totpDigits",
	"totpPeriod",
	"linkedItemId",
] as const satisfies readonly (keyof DecryptedItemData)[];

export function unsupportedDraftFields(data: DecryptedItemData): string[] {
	return UNSUPPORTED_DRAFT_FIELDS.filter((field) => {
		const value = data[field];
		if (value == null || value === "") return false;
		return !Array.isArray(value) || value.length > 0;
	});
}

/** The Login draft the Runtime seals, and nothing else the form happens to carry. */
export function toLoginItemDraft(data: DecryptedItemData): LoginItemDraft {
	return {
		title: data.title,
		url: data.url,
		urls: data.urls,
		username: data.username,
		password: data.password,
		notes: data.notes,
		note: data.note,
		customFields: data.customFields,
		tags: data.tags,
	};
}

/**
 * Why the Runtime cannot accept this create, or `null` when it can.
 *
 * The first create slice seals one Login draft into a personal Vault. Everything outside that
 * is refused here, in front of the user, rather than dropped on the way to the Runtime or
 * written to a transitional repository the vault pages no longer read.
 */
export type CreateRefusal =
	| { readonly reason: "category" }
	| { readonly reason: "unsupportedFields"; readonly fields: string[] }
	| { readonly reason: "noAccount" };

export function refuseCreate(input: {
	readonly accountId: string | null;
	readonly category: ItemCategory;
	readonly data: DecryptedItemData;
}): CreateRefusal | null {
	if (input.category !== "login") return { reason: "category" };
	const fields = unsupportedDraftFields(input.data);
	if (fields.length > 0) return { reason: "unsupportedFields", fields };
	if (input.accountId === null) return { reason: "noAccount" };
	return null;
}
