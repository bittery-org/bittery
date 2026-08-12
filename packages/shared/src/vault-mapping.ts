import type {
	AuthVaultKey,
	SyncBootstrapItem,
	Vault,
	VaultDetails,
	VaultRole,
	VaultType,
} from "@bittery/api-contract";
import type { VaultKeyEntry, VaultSummary } from "@bittery/types";

/**
 * `VaultType` and `VaultRole` are closed sets owned by `apps/server/src/db/enums.rs` and
 * generated into the contract; `VaultSummary` is the canonical decoded vault and
 * `VaultKeyEntry` the canonical stored vault key. All four are re-exported so
 * `@bittery/shared/vault-mapping` stays the one import for the vault vocabulary — aliasing
 * a generated type is allowed, restating it is not (ADR 0012).
 */
export type { VaultRole, VaultType, VaultKeyEntry, VaultSummary };

/**
 * The vault fields every server payload carries. Derived from the generated vault-list
 * entry rather than restated, so a rename server-side fails to compile here; the guards
 * at the foot of the file check that the *other* vault-bearing endpoints still fit.
 */
export type ServerVaultSummary = Pick<
	Vault,
	"id" | "name" | "vaultType" | "icon" | "imageUrl"
>;

export type ServerVaultListEntry = ServerVaultSummary &
	Pick<Vault, "encryptedVaultKey" | "role">;

/** Wire DTO returned as part of signup and recovery auth payloads. */
export type ServerAuthVaultKeyEntry = AuthVaultKey;

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

function toCanonicalVaultKeyEntry(
	input: ServerAuthVaultKeyEntry,
): VaultKeyEntry {
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

// The vault-list entry and the auth vault key are no longer restated — the shapes above
// derive from them — so only the endpoints that carry a vault *without* being one need a
// guard: drift there fails type checks rather than silently corrupting a cache write.
const _bootstrapSummaryMatchesServer = (
	summary: NonNullable<SyncBootstrapItem["vault"]>,
): ServerVaultListEntry => summary;
const _detailsMatchServer = (details: VaultDetails): ServerVaultSummary =>
	details;

void _bootstrapSummaryMatchesServer;
void _detailsMatchServer;
