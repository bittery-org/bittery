import type { ReactNode } from "react";
import type { VaultOption } from "../../types";
import { FormActions } from "./form-actions";
import { VaultSelector } from "./vault-selector";

interface FormWrapperProps {
	children: ReactNode;
	onSubmit: () => void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	currentVaultId: string;
	onVaultChange: (vaultId: string) => void;
}

export function FormWrapper({
	children,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	currentVaultId,
	onVaultChange,
}: FormWrapperProps) {
	const selectedVault = vaults.find((v) => v.id === currentVaultId);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
			className="flex flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 space-y-4 overflow-y-auto py-1 px-1">
				{children}
			</div>

			<div className="mt-4 flex items-center justify-between gap-3 border-t bg-background pt-4 pb-0.5">
				{vaults.length > 0 && (
					<VaultSelector
						vaults={vaults}
						selectedVault={selectedVault}
						onVaultChange={onVaultChange}
					/>
				)}
				<FormActions
					onCancel={onCancel}
					submitLabel={submitLabel}
					isSubmitting={isSubmitting}
				/>
			</div>
		</form>
	);
}
