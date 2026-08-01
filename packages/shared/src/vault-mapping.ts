/**
 * Vault payload mapping.
 *
 * The server serialises vault payloads with `#[serde(rename_all = "camelCase")]`,
 * so the Rust field `vault_type` reaches clients as `vaultType` — never `type`.
 * Every client that reads a vault off the wire must go through this module.
 *
 * Reading `vault.type` from a server payload silently yields `undefined`, which
 * strips the vault of its type in local caches. UI that branches on
 * `vaultType === "team"` (member management, sharing) then disappears until the
 * cache is rebuilt by a code path that happened to map the field correctly.
 */

import type {
	BootstrapItemResponse,
	VaultDetailsResponse,
	VaultListEntryResponse,
} from "@bittery/rust-rpc";

export type VaultType = "personal" | "team";
export type VaultRole = "owner" | "admin" | "member" | "read-only";

/**
 * The vault fields every server payload carries. Structural on purpose: clients
 * declare their own RPC client interfaces, and typing those against this shape
 * makes a future rename fail the build instead of silently producing `undefined`.
 */
export interface ServerVaultSummary {
	id: string;
	name: string;
	vaultType: string;
	icon: string | null;
	imageUrl: string | null;
}

export interface ServerVaultListEntry extends ServerVaultSummary {
	encryptedVaultKey: string;
	role: string;
}

/** Local shape stored per vault the user holds a key for. */
export interface VaultKeyEntry {
	vaultId: string;
	vaultName: string;
	vaultType: VaultType;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: VaultRole;
}

export function normalizeVaultType(
	vaultType: string | null | undefined,
): VaultType {
	return vaultType === "team" ? "team" : "personal";
}

export function normalizeVaultRole(role: string | null | undefined): VaultRole {
	switch (role) {
		case "owner":
		case "admin":
		case "member":
		case "read-only":
			return role;
		default:
			return "member";
	}
}

/** Map a `vault.list` entry to the locally stored vault key record. */
export function toVaultKeyEntry(vault: ServerVaultListEntry): VaultKeyEntry {
	return {
		vaultId: vault.id,
		vaultName: vault.name,
		vaultType: normalizeVaultType(vault.vaultType),
		vaultIcon: vault.icon,
		vaultImageUrl: vault.imageUrl,
		encryptedVaultKey: vault.encryptedVaultKey,
		role: normalizeVaultRole(vault.role),
	};
}

/**
 * Map any server vault payload to the cached metadata shape, whose `type` field
 * is the local name for the wire's `vaultType`.
 */
export function toCachedVaultFields(vault: ServerVaultSummary): {
	id: string;
	name: string;
	type: VaultType;
	icon: string | null;
	imageUrl: string | null;
} {
	return {
		id: vault.id,
		name: vault.name,
		type: normalizeVaultType(vault.vaultType),
		icon: vault.icon,
		imageUrl: vault.imageUrl,
	};
}

// Compile-time drift guards. If the RPC schema renames or drops a vault field,
// these stop assigning and `check-types` fails here rather than at runtime in a
// cache write that nothing observes.
const _listEntryMatchesServer = (
	entry: VaultListEntryResponse,
): ServerVaultListEntry => entry;
const _bootstrapSummaryMatchesServer = (
	summary: NonNullable<BootstrapItemResponse["vault"]>,
): ServerVaultListEntry => summary;
const _detailsMatchServer = (
	details: VaultDetailsResponse,
): ServerVaultSummary => details;

void _listEntryMatchesServer;
void _bootstrapSummaryMatchesServer;
void _detailsMatchServer;
