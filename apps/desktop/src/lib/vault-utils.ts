import type { useRPCClient } from "@bittery/shared/rpc";
import { storage } from "@/lib/storage";

function normalizeVaultType(vaultType: string): "personal" | "team" {
	return vaultType === "team" ? "team" : "personal";
}

function normalizeVaultRole(
	role: string,
): "owner" | "admin" | "member" | "read-only" {
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

export async function refreshVaultKeys(
	rpcClient: ReturnType<typeof useRPCClient>,
): Promise<void> {
	const vaultList = await rpcClient.vault.list.query();
	await storage.storeVaultKeys(
		vaultList.map((v) => ({
			vaultId: v.id,
			vaultName: v.name,
			vaultType: normalizeVaultType(v.vaultType),
			vaultIcon: v.icon,
			vaultImageUrl: v.imageUrl,
			encryptedVaultKey: v.encryptedVaultKey,
			role: normalizeVaultRole(v.role),
		})),
	);
}
