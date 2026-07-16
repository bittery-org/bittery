import type { ReactNode } from "react";
import type { VaultOption } from "../../types";
import { FormActions } from "./form-actions";
import { VaultSelector } from "./vault-selector";

interface FormWrapperProps {
	children: ReactNode;
	onSubmit: () => void;
	onCancel: () => void;
	submitLabel?: string;
	cancelLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	currentVaultId: string;
	onVaultChange: (vaultId: string) => void;
}

export function FormWrapper({
	children,
	onSubmit,
	onCancel,
	submitLabel,
	cancelLabel,
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
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 divide-y divide-border overflow-y-auto">
				{children}
			</div>

			<div className="flex items-center justify-between gap-3 border-t px-6 py-4">
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
					cancelLabel={cancelLabel}
					isSubmitting={isSubmitting}
				/>
			</div>
		</form>
	);
}
