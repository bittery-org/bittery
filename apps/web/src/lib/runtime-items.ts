import type { UnifiedItem } from "@bittery/core/hooks";

export const RUNTIME_ITEMS_OBSERVATION = {
	type: "items",
} as const;

export function runtimeItemsObservationJson(accountId: string): string {
	return JSON.stringify({
		type: RUNTIME_ITEMS_OBSERVATION.type,
		accountId,
	});
}

/**
 * Maps a Runtime Items observation onto the existing list shape. Filter, sort,
 * and render stay in the host ItemList.
 */
export function mapRuntimeItemsProjection(projection: {
	accountId: string;
	replicaRevision: string | number;
	items: Array<{
		itemId: string;
		accountId: string;
		vaultId: string;
		title: string;
		url?: string;
		urls?: string[];
		username?: string;
		password?: string;
		notes?: string;
		note?: string;
		tags?: string[];
		status: string;
		favorite?: boolean;
		createdAt?: string;
		updatedAt?: string;
	}>;
}): UnifiedItem[] {
	return projection.items.map((item) => ({
		id: item.itemId,
		accountId: item.accountId,
		vaultId: item.vaultId,
		title: item.title,
		url: item.url,
		urls: item.urls ?? [],
		username: item.username,
		password: item.password,
		notes: item.notes,
		note: item.note,
		tags: item.tags ?? [],
		category: "login",
		favorite: item.favorite === true,
		createdAt: item.createdAt ?? "",
		updatedAt: item.updatedAt ?? "",
		// ItemDetailPane still consumes the repository item shape until ticket 22.
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

export function bindRuntimeItemsObservation(
	host: {
		observe(
			observationId: string,
			requestJson: string,
			listener: (projectionJson: string) => void,
		): Promise<void>;
		unobserve(observationId: string): Promise<void>;
	},
	accountId: string,
	onItems: (items: UnifiedItem[]) => void,
	onFailure?: () => void,
): () => void {
	const observationId = `items:${accountId}`;
	void host
		.observe(
			observationId,
			runtimeItemsObservationJson(accountId),
			(projectionJson) => {
				onItems(parseRuntimeItemsObservation(projectionJson));
			},
		)
		.catch(() => {
			onFailure?.();
		});
	return () => {
		void host.unobserve(observationId);
	};
}

export function parseRuntimeItemsObservation(
	projectionJson: string,
): UnifiedItem[] {
	try {
		const parsed = JSON.parse(projectionJson) as {
			type?: string;
			value?: Parameters<typeof mapRuntimeItemsProjection>[0];
		};
		if (
			parsed.type !== RUNTIME_ITEMS_OBSERVATION.type ||
			parsed.value == null
		) {
			return [];
		}
		return mapRuntimeItemsProjection(parsed.value);
	} catch {
		return [];
	}
}
