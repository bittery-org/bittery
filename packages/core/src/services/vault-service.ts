import {
	decodeVaultType,
	type ServerVaultListEntry,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore } from "@bittery/storage";
import type { VaultKeyData } from "@bittery/storage/types";
import type { AccountResolver } from "./account-resolver";

/** Vault image updates accept a File because the upload needs its name, MIME type, and body. */
export interface UpdateVaultInput {
	vaultId: string;
	name?: string;
	icon?: string | null;
	imageFile?: File;
	removeImage?: boolean;
	accountId: string;
}

export interface ConvertVaultTypeInput {
	vaultId: string;
	targetType: "personal" | "team";
	personalEncryptedVaultKey?: string;
	accountId: string;
}

export interface ConvertVaultTypeResult {
	success: true;
	vaultId: string;
	previousType: "personal" | "team";
	newType: "personal" | "team";
}

export type VaultListItem = Omit<ServerVaultListEntry, "icon" | "imageUrl"> & {
	icon?: string | null;
	imageUrl?: string | null;
};

export interface ApiVaultClient {
	vaults: {
		list: () => Promise<{ data: readonly VaultListItem[] }>;
	};
}

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	apiClient: ApiVaultClient,
	storage: AccountStore,
	accountId: string,
): Promise<VaultKeyData[]> {
	const { data: vaultList } = await apiClient.vaults.list();
	const vaultKeys = vaultList.map((vault) =>
		toVaultKeyEntry({
			...vault,
			icon: vault.icon ?? null,
			imageUrl: vault.imageUrl ?? null,
		}),
	);
	await storage.storeVaultKeys(vaultKeys, accountId);
	return vaultKeys;
}

interface VaultKeyProjection {
	syncVaultKeys(vaultKeys: VaultKeyData[], accountId: string): Promise<void>;
}

interface VaultServiceDeps {
	storage: AccountStore;
	accounts: AccountResolver;
	vaultKeyProjection: VaultKeyProjection;
}

export class VaultService {
	private readonly storage: AccountStore;
	private readonly accounts: AccountResolver;
	private readonly vaultKeyProjection: VaultKeyProjection;

	constructor(deps: VaultServiceDeps) {
		this.storage = deps.storage;
		this.accounts = deps.accounts;
		this.vaultKeyProjection = deps.vaultKeyProjection;
	}

	async updateVault(input: UpdateVaultInput): Promise<void> {
		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(accountId);

		if (input.name !== undefined) {
			const trimmedName = input.name.trim();
			if (!trimmedName) {
				throw new Error("Vault name is required");
			}
			if (trimmedName.length < 2) {
				throw new Error("Vault name must be at least 2 characters");
			}
		}

		let imageKey: string | null | undefined;
		if (input.imageFile) {
			const { data: upload } = await client.vaults.createImageUpload(
				input.vaultId,
				{
					fileName: input.imageFile.name,
					contentType: input.imageFile.type,
				},
			);

			const uploadResponse = await fetch(upload.uploadUrl, {
				method: "PUT",
				body: input.imageFile,
				headers: {
					"Content-Type": input.imageFile.type,
				},
			});

			if (!uploadResponse.ok) {
				throw new Error("Failed to upload vault image");
			}

			imageKey = upload.key;
		} else if (input.removeImage) {
			imageKey = null;
		}

		await client.vaults.update(
			input.vaultId,
			{
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.icon !== undefined ? { icon: input.icon } : {}),
				...(imageKey !== undefined ? { imageKey } : {}),
			},
			{},
		);
	}

	async convertVaultType(
		input: ConvertVaultTypeInput,
	): Promise<ConvertVaultTypeResult> {
		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(accountId);
		const { data: result } = await client.vaults.convertType(input.vaultId, {
			targetType: input.targetType,
			personalEncryptedVaultKey: input.personalEncryptedVaultKey ?? null,
		});

		if (!result.success) {
			throw new Error("Vault type conversion failed");
		}

		return {
			success: true,
			vaultId: result.vaultId,
			previousType: decodeVaultType(result.previousType),
			newType: decodeVaultType(result.newType),
		};
	}

	async deleteVault(vaultId: string, accountId: string): Promise<void> {
		const client = await this.accounts.getClientForAccount(accountId);
		await client.vaults.remove(vaultId, {});
	}

	async refreshVaultKeys(accountId: string): Promise<void> {
		const client = await this.accounts.getClientForAccount(accountId);
		const vaultKeys = await refreshVaultKeys(client, this.storage, accountId);
		await this.vaultKeyProjection.syncVaultKeys(vaultKeys, accountId);
	}
}
