/**
 * Storage key helpers for per-account namespacing.
 * Keys are scoped by stable accountId (not email).
 */

/** Suffixes used for per-account persisted storage keys. */
export const ACCOUNT_STORAGE_SUFFIXES = [
	"secret_key",
	"session_data",
	"vault_keys",
	"pinned_kdf_params",
	"biometric_enabled",
	"last_biometric_auth",
	"server_url",
	"encrypted_private_key",
	"cached_items",
	"cached_vaults",
	"item_cache_meta",
	"travel_mode_cache",
	"jwt_token",
] as const;

export type AccountStorageSuffix = (typeof ACCOUNT_STORAGE_SUFFIXES)[number];

/** Build a namespaced storage key for an account (accountId is a UUID). */
export function getAccountKey(accountId: string, suffix: string): string {
	return `bittery_account_${accountId}_${suffix}`;
}

/** Legacy email-based key used before accountId migration. */
export function getLegacyAccountKey(email: string, suffix: string): string {
	const sanitized = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
	return `bittery_account_${sanitized}_${suffix}`;
}

export const ACCOUNT_ID_MIGRATION_FLAG = "bittery_account_id_migration_v1";
