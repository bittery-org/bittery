import type { VaultOption } from "../../types";

export interface BaseFormProps {
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	selectedVaultId?: string;
}
