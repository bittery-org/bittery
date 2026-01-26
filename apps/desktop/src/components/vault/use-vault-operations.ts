import { useTRPCClient } from "@bittery/shared/trpc";
import { toast } from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { storage } from "@/lib/storage";
import { encrypt, generateEncryptionKey } from "../../lib/tauri-crypto";
import { refreshVaultKeys } from "../../lib/vault-utils";
import { useQueryInvalidator } from "../../providers/sync-provider";

export interface VaultFormData {
	name: string;
	type: "personal" | "team";
	icon: string;
	imageFile: File | null;
}

export function useVaultOperations() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();

	const createVault = async (data: VaultFormData): Promise<void> => {
		if (!data.name.trim()) {
			throw new Error("Vault name is required");
		}

		if (data.name.trim().length < 2) {
			throw new Error("Vault name must be at least 2 characters");
		}

		let imageKey: string | undefined;

		if (data.imageFile) {
			if (!data.imageFile.type.startsWith("image/")) {
				throw new Error("Vault image must be an image file");
			}

			const upload = await trpcClient.vault.createImageUpload.mutate({
				fileName: data.imageFile.name,
				contentType: data.imageFile.type,
			});

			const uploadResponse = await fetch(upload.uploadUrl, {
				method: "PUT",
				headers: {
					"Content-Type": data.imageFile.type,
				},
				body: data.imageFile,
			});

			if (!uploadResponse.ok) {
				throw new Error("Failed to upload vault image");
			}

			imageKey = upload.key;
		}

		const vaultKey = await generateEncryptionKey();
		const masterUnlockKey = await storage.getMasterUnlockKey();

		if (!masterUnlockKey) {
			throw new Error("Master Unlock Key not found");
		}

		const encryptedVaultKeyData = await encrypt(
			btoa(String.fromCharCode(...vaultKey)),
			masterUnlockKey,
		);

		const result = await trpcClient.vault.create.mutate({
			name: data.name.trim(),
			type: data.type,
			encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
			icon: data.icon,
			...(imageKey && { imageKey }),
		});

		await refreshVaultKeys(trpcClient);
		await invalidator.invalidateVaultKeys();

		navigate({ to: "/vault/$id", params: { id: result.vaultId } });
	};

	const updateVault = async (vaultId: string, name: string) => {
		if (!name.trim()) {
			throw new Error("Vault name is required");
		}

		if (name.trim().length < 2) {
			throw new Error("Vault name must be at least 2 characters");
		}

		await trpcClient.vault.update.mutate({
			vaultId,
			name: name.trim(),
		});

		await refreshVaultKeys(trpcClient);
		await invalidator.invalidateVaultKeys();
	};

	const deleteVault = async (vaultId: string, currentVaultId?: string) => {
		await trpcClient.vault.delete.mutate({ vaultId });

		await refreshVaultKeys(trpcClient);
		await invalidator.invalidateVaultKeys();

		if (currentVaultId === vaultId) {
			navigate({ to: "/vault" });
		}

		toast.success("Vault deleted successfully");
	};

	return {
		createVault,
		updateVault,
		deleteVault,
	};
}
