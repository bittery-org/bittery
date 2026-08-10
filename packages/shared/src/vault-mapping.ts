import type {
	AuthVaultKey,
	SyncBootstrapItem,
	Vault,
	VaultDetails,
} from "@bittery/api-contract";

export type VaultType = "personal" | "team";
export type VaultRole = "owner" | "admin" | "member" | "read-only";

/** Structural wire shape keeps client-specific API interfaces checked at compile time. */
export interface ServerVaultSummary {
	id: string;
	name: string;
	vaultType: string;
	icon?: string | null;
	imageUrl?: string | null;
}

export interface ServerVaultListEntry extends ServerVaultSummary {
	encryptedVaultKey: string;
	role: string;
}

/** Wire DTO returned as part of signup and recovery auth payloads. */
export interface ServerAuthVaultKeyEntry {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
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

/** Canonical vault metadata used by item caches and downstream domain models. */
export interface VaultSummary {
	id: string;
	name: string;
	type: VaultType;
	icon: string | null;
	imageUrl: string | null;
}

export function decodeVaultType(
	vaultType: string | null | undefined,
): VaultType {
	return vaultType === "team" ? "team" : "personal";
}

export function decodeVaultRole(role: string | null | undefined): VaultRole {
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

function toCanonicalVaultKeyEntry(input: {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: string;
}): VaultKeyEntry {
	return {
		vaultId: input.vaultId,
		vaultName: input.vaultName,
		vaultType: decodeVaultType(input.vaultType),
		vaultIcon: input.vaultIcon,
		vaultImageUrl: input.vaultImageUrl,
		encryptedVaultKey: input.encryptedVaultKey,
		role: decodeVaultRole(input.role),
	};
}

/** Decode a `vault.list` payload into the local key-storage shape. */
export function toVaultKeyEntry(vault: ServerVaultListEntry): VaultKeyEntry {
	return toCanonicalVaultKeyEntry({
		vaultId: vault.id,
		vaultName: vault.name,
		vaultIcon: vault.icon,
		vaultImageUrl: vault.imageUrl,
		vaultType: vault.vaultType,
		encryptedVaultKey: vault.encryptedVaultKey,
		role: vault.role,
	});
}

/**
 * Map any server vault payload to the cached metadata shape, whose `type` field
 * is the local name for the wire's `vaultType`.
 */
export function toCachedVaultFields(vault: ServerVaultSummary): VaultSummary {
	return {
		id: vault.id,
		name: vault.name,
		type: decodeVaultType(vault.vaultType),
		icon: vault.icon ?? null,
		imageUrl: vault.imageUrl ?? null,
	};
}

/** Decode auth's vault-key DTO into the local key-storage shape. */
export function toAuthVaultKeyEntry(
	vault: ServerAuthVaultKeyEntry,
): VaultKeyEntry {
	return toCanonicalVaultKeyEntry(vault);
}

// Schema drift fails type checks here rather than silently corrupting a cache write.
const _listEntryMatchesServer = (entry: Vault): ServerVaultListEntry => entry;
const _authVaultKeyMatchesServer = (
	entry: AuthVaultKey,
): ServerAuthVaultKeyEntry => entry;
const _bootstrapSummaryMatchesServer = (
	summary: NonNullable<SyncBootstrapItem["vault"]>,
): ServerVaultListEntry => summary;
const _detailsMatchServer = (details: VaultDetails): ServerVaultSummary =>
	details;

void _listEntryMatchesServer;
void _authVaultKeyMatchesServer;
void _bootstrapSummaryMatchesServer;
void _detailsMatchServer;
