import { useI18n } from "@bittery/i18n/react";
import {
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Input } from "../../input";
import { Label } from "../../label";
import { toast } from "../../sonner";
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
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_form_toast_save_credit_card_failed();
				toast.error(errorMessage);
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
							placeholder={m.vaults_detail_items_form_credit_card_placeholder_title()}
						/>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="cardholderName">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_credit_card_field_cardholder_name_required()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_credit_card_placeholder_cardholder_name()}
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
									{m.vaults_detail_items_form_credit_card_field_card_number_required()}
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
								placeholder={m.vaults_detail_items_form_credit_card_placeholder_card_number()}
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
									{m.vaults_detail_items_form_credit_card_field_expiry_date_required()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => handleExpiryChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_credit_card_placeholder_expiry_date()}
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
									{m.vaults_detail_items_form_credit_card_field_cvv_required()}
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
									placeholder={m.vaults_detail_items_form_credit_card_placeholder_cvv()}
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
							label={m.vaults_detail_items_form_credit_card_field_billing_address()}
							placeholder={m.vaults_detail_items_form_credit_card_placeholder_billing_address()}
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
