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
	FormSection,
	FormWrapper,
	NotesField,
	TitleField,
	useFormVault,
} from "./shared";

export interface CreditCardFormData {
	title: string;
	cardholderName?: string;
	cardNumber?: string;
	cvv?: string;
	expiryDate?: string;
	billingAddress?: string;
	notes?: string;
	tags?: string[];
}

interface CreditCardFormProps extends BaseFormProps {
	allowIncomplete?: boolean;
	initialData?: Partial<CreditCardFormData>;
	onSubmit: (data: CreditCardFormData, vaultId: string) => Promise<void> | void;
}

export function CreditCardForm({
	allowIncomplete = false,
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	cancelLabel,
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
				// Empty controls do not invent fields absent from an imported Card. A field
				// the user clears (or which was explicitly empty) keeps that intentional empty value.
				const optional = (current: string, previous: string | undefined) =>
					current || (previous === undefined ? undefined : "");
				const submitData: CreditCardFormData = allowIncomplete
					? {
							title: value.title,
							cardholderName: optional(
								value.cardholderName,
								initialData?.cardholderName,
							),
							cardNumber: optional(value.cardNumber, initialData?.cardNumber),
							cvv: optional(value.cvv, initialData?.cvv),
							expiryDate: optional(value.expiryDate, initialData?.expiryDate),
							billingAddress: optional(
								value.billingAddress,
								initialData?.billingAddress,
							),
							notes: optional(value.notes, initialData?.notes),
							tags: initialData?.tags,
						}
					: { ...value, tags: initialData?.tags };
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
			cancelLabel={cancelLabel}
			isSubmitting={isSubmitting}
			vaults={vaults}
			currentVaultId={currentVaultId}
			onVaultChange={setCurrentVaultId}
		>
			<FormSection>
				<form.Field name="title">
					{(field) => (
						<TitleField
							field={field}
							placeholder={m.vaults_detail_items_form_credit_card_placeholder_title()}
							autoFocus={!field.state.value}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_credit_card_section_card_details()}
			>
				<form.Field name="cardholderName">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{allowIncomplete
									? m.vaults_detail_items_detail_credit_card_field_cardholder_name()
									: m.vaults_detail_items_form_credit_card_field_cardholder_name_required()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_credit_card_placeholder_cardholder_name()}
								required={!allowIncomplete}
							/>
						</div>
					)}
				</form.Field>

				<form.Field name="cardNumber">
					{(field) => (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label htmlFor={field.name}>
									{allowIncomplete
										? m.vaults_detail_items_detail_credit_card_field_card_number()
										: m.vaults_detail_items_form_credit_card_field_card_number_required()}
								</Label>
								{detectedBrand && (
									<span className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
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
								required={!allowIncomplete}
								className="font-mono"
								maxLength={19}
							/>
						</div>
					)}
				</form.Field>

				<div className="grid grid-cols-2 gap-4">
					<form.Field name="expiryDate">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{allowIncomplete
										? m.vaults_detail_items_detail_credit_card_field_expiry_date()
										: m.vaults_detail_items_form_credit_card_field_expiry_date_required()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => handleExpiryChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_credit_card_placeholder_expiry_date()}
									required={!allowIncomplete}
									className="font-mono"
									maxLength={5}
								/>
							</div>
						)}
					</form.Field>

					<form.Field name="cvv">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{allowIncomplete
										? m.vaults_detail_items_detail_credit_card_field_cvv()
										: m.vaults_detail_items_form_credit_card_field_cvv_required()}
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
									required={!allowIncomplete}
									className="font-mono"
									maxLength={4}
								/>
							</div>
						)}
					</form.Field>
				</div>
			</FormSection>

			<FormSection>
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

				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</FormSection>
		</FormWrapper>
	);
}
