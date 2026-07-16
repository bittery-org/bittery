/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import { useI18n } from "@bittery/i18n/react";
import {
	type Address,
	formatSSN,
	type PhoneNumber,
} from "@bittery/shared/identity";
import { useForm } from "@tanstack/react-form";
import { nanoid } from "nanoid";
import { useState } from "react";
import {
	IconPlusOutlineDuo18,
	IconTrash2OutlineDuo18,
	IconXmarkOutlineDuo18,
} from "../../../icons";
import { Button } from "../../button";
import { Input } from "../../input";
import { Label } from "../../label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../select";
import { toast } from "../../sonner";
import {
	type BaseFormProps,
	FormAddRow,
	FormSection,
	FormWrapper,
	NotesField,
	TitleField,
	useFormVault,
} from "./shared";

export interface IdentityFormData {
	title: string;
	firstName: string;
	middleName?: string;
	lastName: string;
	email: string;
	addresses?: Address[];
	phoneNumbers?: PhoneNumber[];
	ssn?: string;
	passportNumber?: string;
	driversLicense?: string;
	dateOfBirth?: string;
	notes: string;
	tags?: string[];
}

interface IdentityFormProps extends BaseFormProps {
	initialData?: Partial<IdentityFormData>;
	onSubmit: (data: IdentityFormData, vaultId: string) => Promise<void> | void;
}

export function IdentityForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	cancelLabel,
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: IdentityFormProps) {
	const { m } = useI18n();
	const { currentVaultId, setCurrentVaultId } = useFormVault(
		vaults,
		selectedVaultId,
	);
	const [addresses, setAddresses] = useState<Address[]>(
		initialData?.addresses || [],
	);
	const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>(
		initialData?.phoneNumbers || [],
	);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			firstName: initialData?.firstName || "",
			middleName: initialData?.middleName || "",
			lastName: initialData?.lastName || "",
			email: initialData?.email || "",
			ssn: initialData?.ssn || "",
			passportNumber: initialData?.passportNumber || "",
			driversLicense: initialData?.driversLicense || "",
			dateOfBirth: initialData?.dateOfBirth || "",
			notes: initialData?.notes || "",
		},
		onSubmit: async ({ value }) => {
			try {
				const submitData: IdentityFormData = {
					...value,
					addresses: addresses.length > 0 ? addresses : undefined,
					phoneNumbers: phoneNumbers.length > 0 ? phoneNumbers : undefined,
					tags: initialData?.tags,
				};
				await onSubmit(submitData, currentVaultId);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_form_toast_save_identity_failed();
				toast.error(errorMessage);
			}
		},
	});

	const addAddress = () => {
		setAddresses([
			...addresses,
			{ id: nanoid(), street: "", city: "", state: "", zip: "", country: "" },
		]);
	};

	const updateAddress = (id: string, field: Partial<Address>) => {
		setAddresses(
			addresses.map((addr) => (addr.id === id ? { ...addr, ...field } : addr)),
		);
	};

	const removeAddress = (id: string) => {
		setAddresses(addresses.filter((addr) => addr.id !== id));
	};

	const addPhoneNumber = () => {
		setPhoneNumbers([
			...phoneNumbers,
			{ id: nanoid(), label: "Mobile", number: "" },
		]);
	};

	const updatePhoneNumber = (id: string, field: Partial<PhoneNumber>) => {
		setPhoneNumbers(
			phoneNumbers.map((phone) =>
				phone.id === id ? { ...phone, ...field } : phone,
			),
		);
	};

	const removePhoneNumber = (id: string) => {
		setPhoneNumbers(phoneNumbers.filter((phone) => phone.id !== id));
	};

	const handleSSNChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");
		form.setFieldValue("ssn", cleaned);
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
							placeholder={m.vaults_detail_items_form_identity_placeholder_title()}
							autoFocus={!field.state.value}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_identity_section_personal_information()}
			>
				<div className="grid grid-cols-2 gap-4">
					<form.Field name="firstName">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_first_name()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_identity_placeholder_first_name()}
								/>
							</div>
						)}
					</form.Field>

					<form.Field name="lastName">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_last_name()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_identity_placeholder_last_name()}
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<form.Field name="middleName">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_middle_name()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_identity_placeholder_middle_name()}
								/>
							</div>
						)}
					</form.Field>

					<form.Field name="dateOfBirth">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_date_of_birth()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									type="date"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
								/>
							</div>
						)}
					</form.Field>
				</div>

				<form.Field name="email">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_identity_field_email()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								type="email"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_identity_placeholder_email()}
							/>
						</div>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_identity_section_phone_numbers()}
			>
				{phoneNumbers.map((phone) => (
					<div key={phone.id} className="flex items-center gap-2">
						<Select
							value={phone.label}
							onValueChange={(value) =>
								updatePhoneNumber(phone.id, { label: value })
							}
						>
							<SelectTrigger className="w-28 shrink-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="Mobile">
									{m.vaults_detail_items_form_identity_phone_type_mobile()}
								</SelectItem>
								<SelectItem value="Home">
									{m.vaults_detail_items_form_identity_phone_type_home()}
								</SelectItem>
								<SelectItem value="Work">
									{m.vaults_detail_items_form_identity_phone_type_work()}
								</SelectItem>
								<SelectItem value="Other">
									{m.vaults_detail_items_form_identity_phone_type_other()}
								</SelectItem>
							</SelectContent>
						</Select>
						<Input
							type="tel"
							placeholder={m.vaults_detail_items_form_identity_placeholder_phone_number()}
							value={phone.number}
							onChange={(e) =>
								updatePhoneNumber(phone.id, { number: e.target.value })
							}
							className="flex-1"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
							onClick={() => removePhoneNumber(phone.id)}
							aria-label={m.vaults_detail_items_form_identity_action_remove_phone()}
						>
							<IconTrash2OutlineDuo18 size={16} />
						</Button>
					</div>
				))}
				<FormAddRow onClick={addPhoneNumber}>
					<IconPlusOutlineDuo18 className="size-3.5" />
					{m.vaults_detail_items_form_identity_action_add_phone()}
				</FormAddRow>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_identity_section_addresses()}
			>
				{addresses.map((address) => (
					<div
						key={address.id}
						className="space-y-2 rounded-lg border bg-card p-3"
					>
						<div className="flex items-center justify-between">
							<Label className="font-medium text-xs">
								{m.vaults_detail_items_form_identity_field_address()}
							</Label>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
								onClick={() => removeAddress(address.id)}
								aria-label={m.vaults_detail_items_form_identity_action_remove_address()}
							>
								<IconXmarkOutlineDuo18 size={16} />
							</Button>
						</div>
						<Input
							placeholder={m.vaults_detail_items_form_identity_placeholder_street_address()}
							value={address.street}
							onChange={(e) =>
								updateAddress(address.id, { street: e.target.value })
							}
						/>
						<div className="grid grid-cols-2 gap-2">
							<Input
								placeholder={m.vaults_detail_items_form_identity_placeholder_city()}
								value={address.city}
								onChange={(e) =>
									updateAddress(address.id, { city: e.target.value })
								}
							/>
							<Input
								placeholder={m.vaults_detail_items_form_identity_placeholder_state()}
								value={address.state}
								onChange={(e) =>
									updateAddress(address.id, { state: e.target.value })
								}
							/>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<Input
								placeholder={m.vaults_detail_items_form_identity_placeholder_zip_code()}
								value={address.zip}
								onChange={(e) =>
									updateAddress(address.id, { zip: e.target.value })
								}
							/>
							<Input
								placeholder={m.vaults_detail_items_form_identity_placeholder_country()}
								value={address.country}
								onChange={(e) =>
									updateAddress(address.id, { country: e.target.value })
								}
							/>
						</div>
					</div>
				))}
				<FormAddRow onClick={addAddress}>
					<IconPlusOutlineDuo18 className="size-3.5" />
					{m.vaults_detail_items_form_identity_action_add_address()}
				</FormAddRow>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_identity_section_government_ids()}
			>
				<form.Field name="ssn">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_identity_field_social_security_number()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								type="password"
								value={formatSSN(field.state.value)}
								onBlur={field.handleBlur}
								onChange={(e) => handleSSNChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_identity_placeholder_ssn()}
								className="font-mono"
								maxLength={11}
							/>
						</div>
					)}
				</form.Field>

				<div className="grid grid-cols-2 gap-4">
					<form.Field name="passportNumber">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_passport_number()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									type="password"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_identity_placeholder_passport_number()}
									className="font-mono"
								/>
							</div>
						)}
					</form.Field>

					<form.Field name="driversLicense">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_identity_field_drivers_license()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									type="password"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_identity_placeholder_drivers_license()}
									className="font-mono"
								/>
							</div>
						)}
					</form.Field>
				</div>
			</FormSection>

			<FormSection>
				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</FormSection>
		</FormWrapper>
	);
}
