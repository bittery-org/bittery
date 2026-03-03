import {
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import {
	type BaseFormProps,
	FormWrapper,
	NotesField,
	TitleField,
	useFormVault,
} from "./shared";

export interface CreditCardFormData {
	title: string;
	cardholderName: string;
	cardNumber: string;
	cvv: string;
	expiryDate: string;
	billingAddress: string;
	notes: string;
	tags?: string[];
}

interface CreditCardFormProps extends BaseFormProps {
	initialData?: Partial<CreditCardFormData>;
	onSubmit: (data: CreditCardFormData, vaultId: string) => Promise<void> | void;
}

export function CreditCardForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: CreditCardFormProps) {
	const { m } = useI18n();
	const { currentVaultId, setCurrentVaultId } = useFormVault(
		vaults,
		selectedVaultId,
	);
	const [detectedBrand, setDetectedBrand] = useState<string>("");

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
				const submitData: CreditCardFormData = {
					...value,
					tags: initialData?.tags,
				};
				await onSubmit(submitData, currentVaultId);
			} catch (error) {
				toast.error(
					m["vaults.detail.items.form.toast.save_credit_card_failed"](),
				);
				console.error(error);
			}
		},
	});

	const handleCardNumberChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");
		if (cleaned.length >= 4) {
			setDetectedBrand(detectCardBrand(cleaned));
		} else {
			setDetectedBrand("");
		}
		form.setFieldValue("cardNumber", cleaned);
	};

	const handleExpiryChange = (value: string) => {
		let cleaned = value.replace(/\D/g, "");
		if (cleaned.length >= 2) {
			cleaned = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
		}
		form.setFieldValue("expiryDate", cleaned);
	};

	return (
		<FormWrapper
			onSubmit={form.handleSubmit}
			onCancel={onCancel}
			submitLabel={submitLabel}
			isSubmitting={isSubmitting}
			vaults={vaults}
			currentVaultId={currentVaultId}
			onVaultChange={setCurrentVaultId}
		>
			<div>
				<form.Field name="title">
					{(field) => (
						<TitleField
							field={field}
							placeholder={m[
								"vaults.detail.items.form.credit_card.placeholder.title"
							]()}
						/>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="cardholderName">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m[
									"vaults.detail.items.form.credit_card.field.cardholder_name.required"
								]()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m[
									"vaults.detail.items.form.credit_card.placeholder.cardholder_name"
								]()}
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
								<Label htmlFor={field.name}>
									{m[
										"vaults.detail.items.form.credit_card.field.card_number.required"
									]()}
								</Label>
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
								placeholder={m[
									"vaults.detail.items.form.credit_card.placeholder.card_number"
								]()}
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
								<Label htmlFor={field.name}>
									{m[
										"vaults.detail.items.form.credit_card.field.expiry_date.required"
									]()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => handleExpiryChange(e.target.value)}
									placeholder={m[
										"vaults.detail.items.form.credit_card.placeholder.expiry_date"
									]()}
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
								<Label htmlFor={field.name}>
									{m[
										"vaults.detail.items.form.credit_card.field.cvv.required"
									]()}
								</Label>
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
									placeholder={m[
										"vaults.detail.items.form.credit_card.placeholder.cvv"
									]()}
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
						<NotesField
							field={field as any}
							label={m[
								"vaults.detail.items.form.credit_card.field.billing_address"
							]()}
							placeholder={m[
								"vaults.detail.items.form.credit_card.placeholder.billing_address"
							]()}
							rows={3}
						/>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</div>
		</FormWrapper>
	);
}
