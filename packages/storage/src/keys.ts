/**
 * Storage key scheme.
 *
 * One place builds keys. Adapters never build keys, and the Rust native host never
 * re-derives them either — it reads the published `native_view` projection instead.
 *
 * Accounts are keyed by stable accountId (a UUID), never by email.
 */

import type { StoredValueName } from "./tiers";

/** `bittery_account_${accountId}_${name}` */
export function accountKey(accountId: string, name: string): string {
	return `bittery_account_${accountId}_${name}`;
}

/** `bittery_${name}` — for the global values. */
export function globalKey(name: string): string {
	return `bittery_${name}`;
}

/**
 * Device-wide value names: one instance per install, not per account.
 *
 * `master_password_reentry_period_ms` is global on every platform.
 *
 * The `as const satisfies readonly StoredValueName[]` is the assertion that every name
 * here has a row in `STORAGE_TIERS`: a name with no tier declaration fails to compile.
 */
export const GLOBAL_VALUES = [
	"device_key",
	"accounts_list",
	"active_account",
	"master_password_reentry_period_ms",
	"native_view",
] as const satisfies readonly StoredValueName[];

export type GlobalValueName = (typeof GLOBAL_VALUES)[number];

/**
 * Per-account value names, used by clearAllStoredData / removeAccount sweeps.
 *
 * `auto_lock_timeout` is per account on every platform.
 *
 * Same compile-time assertion as `GLOBAL_VALUES`: every name must be tiered.
 */
export const ACCOUNT_VALUES = [
	"secret_key",
	"session_data",
	"vault_keys",
	"pinned_kdf_params",
	"biometric_enabled",
	"last_biometric_auth",
	"server_url",
	"encrypted_private_key",
	"travel_mode_cache",
	"jwt_token",
	"auto_lock_timeout",
	"background_timestamp",
] as const satisfies readonly StoredValueName[];

export type AccountValueName = (typeof ACCOUNT_VALUES)[number];

/**
 * Record-port collection names.
 *
 * Canonical here rather than in `item-cache.ts` because three parties must agree on them:
 * `ItemCache` reads and writes the collections, `AccountStore` publishes their names in the
 * `native_view` projection, and the Rust native host opens them by that published name. One
 * definition means they cannot drift into a silently-empty collection.
 *
 * `collection` is opaque to the ports — an adapter must never parse these strings.
 */
export function itemsCollection(accountId: string): string {
	return `${accountId}:items`;
}

export function vaultsCollection(accountId: string): string {
	return `${accountId}:vaults`;
}

/** Holds a single record with id `"meta"`. */
export function metaCollection(accountId: string): string {
	return `${accountId}:meta`;
}

/** A bootstrap generation is unreachable until ItemCache publishes it from metadata. */
export function stagedItemsCollection(
	accountId: string,
	generation: string,
): string {
	return `item-cache-stage:${accountId}:${generation}:items`;
}

/** See {@link stagedItemsCollection}; adapters must continue to treat this as opaque. */
export function stagedVaultsCollection(
	accountId: string,
	generation: string,
): string {
	return `item-cache-stage:${accountId}:${generation}:vaults`;
}

/** Snapshot of the active items when a staged bootstrap starts. */
export function stagedItemBaselineCollection(
	accountId: string,
	generation: string,
): string {
	return `item-cache-stage:${accountId}:${generation}:item-baseline`;
}
