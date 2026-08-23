import type {
	RuntimeSessionSnapshot,
	RuntimeSnapshot,
} from "@bittery/client-runtime/client";
import type {
	ItemsProjection,
	RuntimeErrorCode,
} from "@bittery/client-runtime/protocol";
import type { UnifiedItem } from "@bittery/core/hooks";

const NO_ITEMS: UnifiedItem[] = [];

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
	readonly items: UnifiedItem[];
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
			state: session.state === "loading" ? "loading" : session.state,
			code: session.code,
		};
	}
	if (items.state === "ready") {
		return {
			items: mapRuntimeItemsProjection(items.value),
			state: "ready",
			code: null,
		};
	}
	if (items.state === "failed") {
		return {
			items: NO_ITEMS,
			state:
				items.code === "AUTHENTICATION_REQUIRED" ? "locked" : "unavailable",
			code: items.code,
		};
	}
	return { items: NO_ITEMS, state: "loading", code: null };
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
): UnifiedItem[] {
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
		// `item.status` has no home here yet. `optimisticFailure` needs an `operationId`
		// and a `CreateItemRejectionCode`, and `ItemProjectionStatus` carries neither, so
		// filling it would mean inventing both. Ticket 22 replaces `UnifiedItem`; the
		// pending/failed distinction lands with the shape that can hold it.
		//
		// ItemDetailPane still consumes the repository item shape until then.
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
