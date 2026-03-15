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
import { toast } from "../../sonner";
import {
	type BaseFormProps,
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
							placeholder={m.vaults_detail_items_form_identity_placeholder_title()}
						/>
					)}
				</form.Field>
			</div>

			<div className="space-y-4 rounded-lg border p-4">
				<h3 className="font-medium text-sm">
					{m.vaults_detail_items_form_identity_section_personal_information()}
				</h3>

				<div className="grid grid-cols-2 gap-4">
					<div>
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
					</div>

					<div>
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
				</div>

				<div>
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
				</div>

				<div>
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
				</div>

				<div>
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
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>
						{m.vaults_detail_items_form_identity_section_phone_numbers()}
					</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addPhoneNumber}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						{m.vaults_detail_items_form_identity_action_add_phone()}
					</Button>
				</div>
				{phoneNumbers.map((phone) => (
					<div key={phone.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex gap-2">
							<select
								value={phone.label}
								onChange={(e) =>
									updatePhoneNumber(phone.id, { label: e.target.value })
								}
								className="rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="Mobile">
									{m.vaults_detail_items_form_identity_phone_type_mobile()}
								</option>
								<option value="Home">
									{m.vaults_detail_items_form_identity_phone_type_home()}
								</option>
								<option value="Work">
									{m.vaults_detail_items_form_identity_phone_type_work()}
								</option>
								<option value="Other">
									{m.vaults_detail_items_form_identity_phone_type_other()}
								</option>
							</select>
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
								onClick={() => removePhoneNumber(phone.id)}
							>
								<IconTrash2OutlineDuo18 size={16} />
							</Button>
						</div>
					</div>
				))}
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>
						{m.vaults_detail_items_form_identity_section_addresses()}
					</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addAddress}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						{m.vaults_detail_items_form_identity_action_add_address()}
					</Button>
				</div>
				{addresses.map((address) => (
					<div key={address.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex items-center justify-between">
							<Label className="font-medium text-xs">
								{m.vaults_detail_items_form_identity_field_address()}
							</Label>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={() => removeAddress(address.id)}
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
			</div>

			<div className="space-y-4 rounded-lg border p-4">
				<h3 className="font-medium text-sm">
					{m.vaults_detail_items_form_identity_section_government_ids()}
				</h3>

				<div>
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
				</div>

				<div>
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
				</div>

				<div>
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
			</div>

			<div>
				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</div>
		</FormWrapper>
	);
}
