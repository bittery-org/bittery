/**
 * Test-only Item fixtures, built on the same mappers `item-mapping.ts` hands to production
 * code — never a fresh object literal.
 *
 * A hand-typed item literal (or one behind an `as CachedEncryptedItem` cast) stops tracking
 * the server's field list the moment it is written: nothing forces it to grow when
 * `ItemPayload` does. These factories return {@link CachedEncryptedItem} / {@link
 * ServerEncryptedItem} unannotated instead, so a field added to the contract fails to
 * compile *here* — inside {@link toNewCachedItem}, the same constructor production code
 * uses — rather than quietly missing from a test fixture.
 */

import type { ItemCategory } from "@bittery/api-contract";
import type { CachedEncryptedItem } from "@bittery/types";
import {
	type CachedItemScope,
	type NewCachedItemInput,
	type ServerEncryptedItem,
	toNewCachedItem,
} from "../item-mapping";

const DEFAULT_TIMESTAMP = "2024-01-01T00:00:00.000Z";

const DEFAULT_SCOPE: Required<CachedItemScope> = {
	accountId: "account-1",
	accountEmail: "account-1@example.com",
	serverUrl: "https://app.bittery.test",
};

/**
 * The subset of {@link NewCachedItemInput} both factories below fill in from overrides.
 * Typed against `ItemPayload`'s own field names (readonly or not, wire or cached — every
 * shape spells them the same) so either override object is accepted without restating them.
 */
interface NewItemOverrides {
	id?: string;
	vaultId?: string;
	category?: ItemCategory;
	createdAt?: string;
	version?: number;
	favorite?: boolean;
	encryptedData?: string;
	encryptionIv?: string;
	encryptionAlgorithm?: string;
	encryptionVersion?: number;
	encryptedByUserId?: string;
}

function newItemInput(overrides: NewItemOverrides): NewCachedItemInput {
	return {
		id: overrides.id ?? "item-1",
		vaultId: overrides.vaultId ?? "vault-1",
		category: overrides.category ?? "login",
		timestamp: overrides.createdAt ?? DEFAULT_TIMESTAMP,
		version: overrides.version ?? 1,
		favorite: overrides.favorite ?? false,
		payload: {
			encryptedData: overrides.encryptedData ?? "encrypted-data",
			encryptionIv: overrides.encryptionIv ?? "iv",
			encryptionAlgorithm: overrides.encryptionAlgorithm ?? "AES-GCM-AAD-V1",
			encryptionVersion: overrides.encryptionVersion ?? 1,
			encryptedByUserId: overrides.encryptedByUserId ?? "user-1",
		},
	};
}

/**
 * A `CachedEncryptedItem` a test can shape with `Partial<>` overrides. Every field not
 * named in `overrides` comes from {@link toNewCachedItem} itself, so the return type is
 * never annotated — the acceptance test for this factory is that it stops compiling the
 * moment a required field is added to the contract and neither this file nor
 * `item-mapping.ts` has been taught about it.
 *
 * Defaults a fully-scoped record (`accountId`/`accountEmail`/`serverUrl` all set): most
 * call sites want a record already on an account and can override the scope, or any other
 * field, through `overrides`.
 */
export function cachedItem(
	overrides: Partial<CachedEncryptedItem> = {},
): CachedEncryptedItem {
	const scope: CachedItemScope = {
		accountId: overrides.accountId ?? DEFAULT_SCOPE.accountId,
		accountEmail: overrides.accountEmail ?? DEFAULT_SCOPE.accountEmail,
		serverUrl: overrides.serverUrl ?? DEFAULT_SCOPE.serverUrl,
	};
	return { ...toNewCachedItem(newItemInput(overrides), scope), ...overrides };
}

/**
 * The wire-shaped counterpart of {@link cachedItem} — what a server response carries, with
 * no account scope (the wire never sends one) and `attachments` in its wider, nullable
 * endpoint spelling rather than the cache's mutable-array-or-absent one.
 */
export function serverEncryptedItem(
	overrides: Partial<ServerEncryptedItem> = {},
): ServerEncryptedItem {
	const base = toNewCachedItem(newItemInput(overrides), {});
	return { ...base, ...overrides };
}
