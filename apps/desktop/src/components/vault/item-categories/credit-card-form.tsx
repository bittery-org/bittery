import {
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { VaultOption } from "../types";

export interface CreditCardFormData {
	title: string;
	cardholderName: string;
	cardNumber: string;
	cvv: string;
	expiryDate: string;
	billingAddress: string;
	notes: string;
}

interface CreditCardFormProps {
	initialData?: Partial<CreditCardFormData>;
	onSubmit: (data: CreditCardFormData, vaultId: string) => Promise<void> | void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	selectedVaultId?: string;
}

export function CreditCardForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: CreditCardFormProps) {
	const [currentVaultId, setCurrentVaultId] = useState<string>(
		selectedVaultId || vaults[0]?.id || "",
	);
	const [detectedBrand, setDetectedBrand] = useState<string>("");

	const selectedVault = vaults.find((v) => v.id === currentVaultId);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			cardholderName: initialData?.cardholderName || "",
			cardNumber: initialData?.cardNumber || "",
			cvv: initialData?.cvv || "",
			expiryDate: initialData?.expiryDate || "",
			billingAddress: initialData?.billingAddress || "",
			notes: initialData?.notes || "",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit(value, currentVaultId);
				toast.success("Credit card saved successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to save credit card";
				toast.error(errorMessage);
			}
		},
	});

	const handleCardNumberChange = (value: string) => {
		// Remove all non-digits
		const cleaned = value.replace(/\D/g, "");

		// Detect brand
		if (cleaned.length >= 4) {
			const brand = detectCardBrand(cleaned);
			setDetectedBrand(brand);
		} else {
			setDetectedBrand("");
		}

		form.setFieldValue("cardNumber", cleaned);
	};

	const handleExpiryChange = (value: string) => {
		// Remove all non-digits
		let cleaned = value.replace(/\D/g, "");

		// Auto-format as MM/YY
		if (cleaned.length >= 2) {
			cleaned = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
		}

		form.setFieldValue("expiryDate", cleaned);
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
			className="flex flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 space-y-4 overflow-y-auto py-1 pr-2">
				<div>
					<form.Field name="title">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Title *</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="My Credit Card"
									required
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="cardholderName">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Cardholder Name *</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="JOHN DOE"
									required
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="cardNumber">
						{(field) => (
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label htmlFor={field.name}>Card Number *</Label>
									{detectedBrand && (
										<span className="text-muted-foreground text-xs">
											{getCardBrandDisplayName(detectedBrand as any)}
										</span>
									)}
								</div>
								<Input
									id={field.name}
									name={field.name}
									value={formatCardNumber(
										field.state.value,
										detectedBrand as any,
									)}
									onBlur={field.handleBlur}
									onChange={(e) => handleCardNumberChange(e.target.value)}
									placeholder="1234 5678 9012 3456"
									className="font-mono"
									required
									maxLength={19}
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<div>
						<form.Field name="expiryDate">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Expiry Date *</Label>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => handleExpiryChange(e.target.value)}
										placeholder="MM/YY"
										className="font-mono"
										required
										maxLength={5}
									/>
								</div>
							)}
						</form.Field>
					</div>

					<div>
						<form.Field name="cvv">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>CVV *</Label>
									<Input
										id={field.name}
										name={field.name}
										type="password"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => {
											const value = e.target.value.replace(/\D/g, "");
											field.handleChange(value);
										}}
										placeholder="123"
										className="font-mono"
										required
										maxLength={4}
									/>
								</div>
							)}
						</form.Field>
					</div>
				</div>

				<div>
					<form.Field name="billingAddress">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Billing Address</Label>
								<textarea
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="123 Main St, Apt 4B, New York, NY 10001"
									rows={3}
									className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="notes">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Notes</Label>
								<textarea
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Additional notes..."
									rows={4}
									className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								/>
							</div>
						)}
					</form.Field>
				</div>
			</div>

			{/* Footer with Vault Selector */}
			<div className="mt-4 flex items-center justify-between gap-3 border-t bg-background pt-4">
				{vaults.length > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								{selectedVault?.name || "Select vault"}
								<ChevronDown className="ml-2 size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{vaults.map((vault) => (
								<DropdownMenuItem
									key={vault.id}
									onClick={() => setCurrentVaultId(vault.id)}
								>
									{vault.name}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<div className="flex flex-1 justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={isSubmitting}>
						{isSubmitting ? "Saving..." : submitLabel}
					</Button>
				</div>
			</div>
		</form>
	);
}
