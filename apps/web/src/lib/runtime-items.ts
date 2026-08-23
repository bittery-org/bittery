import type { ItemsProjection } from "@bittery/client-runtime/protocol";
import type { UnifiedItem } from "@bittery/core/hooks";

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
