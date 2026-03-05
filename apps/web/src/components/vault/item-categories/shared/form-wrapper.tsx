import type { ReactNode } from "react";
import type { VaultOption } from "../../types";
import { FormActions } from "./form-actions";

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
	submitLabel,
	isSubmitting = false,
	vaults: _vaults = [],
	currentVaultId: _currentVaultId,
	onVaultChange: _onVaultChange,
}: FormWrapperProps) {
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
			className="flex flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 space-y-4 overflow-y-auto px-1 py-1">
				{children}
			</div>

			<div className="mt-4 flex items-center justify-end gap-3 border-t bg-background pt-4 pb-0.5">
				<FormActions
					onCancel={onCancel}
					submitLabel={submitLabel}
					isSubmitting={isSubmitting}
				/>
			</div>
		</form>
	);
}
