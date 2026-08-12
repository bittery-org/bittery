/**
 * Desktop Snapshot Item Validation
 *
 * Desktop-mode item reads arrive over native messaging as an untyped JSON
 * blob. That is deliberate and it is stated once, in the generated protocol:
 * `DESKTOP_ITEMS_SNAPSHOT.items` is `Array<Record<string, unknown>>` because
 * the Rust side carries `Vec<serde_json::Value>` — see the comment on that
 * variant in `apps/desktop/src-tauri/src/desktop_ipc.rs`. The payload is the
 * account's decrypted item plaintext, a client-owned shape with no Rust
 * definition, so the desktop app passes it through rather than declaring a
 * second, Rust-flavoured version of it.
 *
 * The desktop app's IPC handler (`build_snapshot_item_payload` in
 * `apps/desktop/src-tauri/src/lib.rs`) decrypts each cached item and merges
 * the *full* decrypted payload with a handful of known metadata fields (id,
 * vaultId, category, favorite, createdAt, updatedAt, vault, accountId,
 * accountEmail) — it does not allow-list or drop any decrypted fields. So
 * the wire payload already carries every `DecryptedItemData` field
 * (passkeys, totp*, credit-card/identity fields, custom fields, etc.), the
 * same way the local WASM/coordinator decrypt path does.
 *
 * We still validate the required structural fields before trusting the rest
 * of the object, since this is data crossing a native-messaging process
 * boundary (a stale/corrupt desktop-app cache entry, or a version skew
 * between the extension and desktop app, should not crash the extension).
 * Unlike the previous per-field allowlist mapper, we no longer reconstruct
 * the item field-by-field — we spread the validated payload through so
 * desktop-mode reads match the local decrypt path field-for-field.
 */

import type { MultiAccountItem } from "@bittery/core/services/item-service";
import type { ItemCategory } from "@bittery/shared/types";
import { decodeVaultType } from "@bittery/shared/vault-mapping";

function isItemCategory(value: unknown): value is ItemCategory {
	return (
		value === "login" ||
		value === "secure-note" ||
		value === "credit-card" ||
		value === "identity" ||
		value === "totp"
	);
}

export function parseDesktopSnapshotItem(
	item: Record<string, unknown>,
): MultiAccountItem | null {
	if (typeof item.id !== "string" || typeof item.vaultId !== "string") {
		return null;
	}

	if (!isItemCategory(item.category)) {
		return null;
	}

	if (typeof item.title !== "string") {
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

	return {
		...item,
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
		vault: {
			id: vault.id,
			name: vault.name,
			type: decodeVaultType(vault.type),
			icon: typeof vault.icon === "string" ? vault.icon : null,
			imageUrl: typeof vault.imageUrl === "string" ? vault.imageUrl : null,
		},
	} as MultiAccountItem;
}
