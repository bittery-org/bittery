import { useState } from "react";
import type { VaultOption } from "../../types";

export function useFormVault(
	vaults: VaultOption[] = [],
	selectedVaultId?: string,
) {
	const [currentVaultId, setCurrentVaultId] = useState<string>(
		selectedVaultId || vaults[0]?.id || "",
	);

	return {
		currentVaultId,
		setCurrentVaultId,
	};
}
