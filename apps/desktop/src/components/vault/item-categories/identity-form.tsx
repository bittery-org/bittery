/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import {
	type Address,
	formatSSN,
	type PhoneNumber,
} from "@bittery/shared/identity";
import { Button, Input, Label, toast } from "@bittery/ui";
import {
	IconPlusOutlineDuo18,
	IconTrash2OutlineDuo18,
	IconXmarkOutlineDuo18,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { nanoid } from "nanoid";
import { useState } from "react";
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
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: IdentityFormProps) {
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
				toast.success("Identity saved successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to save identity";
				toast.error(errorMessage);
			}
		},
	});

	// Address management
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

	// Phone number management
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
						<TitleField field={field} placeholder="Personal Identity" />
					)}
				</form.Field>
			</div>

			{/* Personal Information Section */}
			<div className="space-y-4 rounded-lg border p-4">
				<h3 className="font-medium text-sm">Personal Information</h3>

				<div className="grid grid-cols-2 gap-4">
					<div>
						<form.Field name="firstName">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>First Name</Label>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="John"
									/>
								</div>
							)}
						</form.Field>
					</div>

					<div>
						<form.Field name="lastName">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Last Name</Label>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="Doe"
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
								<Label htmlFor={field.name}>Middle Name</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Michael"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="email">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Email</Label>
								<Input
									id={field.name}
									name={field.name}
									type="email"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="john.doe@example.com"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="dateOfBirth">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Date of Birth</Label>
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

			{/* Phone Numbers Section */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>Phone Numbers</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addPhoneNumber}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						Add Phone
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
								<option value="Mobile">Mobile</option>
								<option value="Home">Home</option>
								<option value="Work">Work</option>
								<option value="Other">Other</option>
							</select>
							<Input
								type="tel"
								placeholder="(555) 123-4567"
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

			{/* Addresses Section */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>Addresses</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addAddress}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						Add Address
					</Button>
				</div>
				{addresses.map((address) => (
					<div key={address.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex items-center justify-between">
							<Label className="font-medium text-xs">Address</Label>
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
							placeholder="Street Address"
							value={address.street}
							onChange={(e) =>
								updateAddress(address.id, { street: e.target.value })
							}
						/>
						<div className="grid grid-cols-2 gap-2">
							<Input
								placeholder="City"
								value={address.city}
								onChange={(e) =>
									updateAddress(address.id, { city: e.target.value })
								}
							/>
							<Input
								placeholder="State"
								value={address.state}
								onChange={(e) =>
									updateAddress(address.id, { state: e.target.value })
								}
							/>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<Input
								placeholder="ZIP Code"
								value={address.zip}
								onChange={(e) =>
									updateAddress(address.id, { zip: e.target.value })
								}
							/>
							<Input
								placeholder="Country"
								value={address.country}
								onChange={(e) =>
									updateAddress(address.id, { country: e.target.value })
								}
							/>
						</div>
					</div>
				))}
			</div>

			{/* Government IDs Section */}
			<div className="space-y-4 rounded-lg border p-4">
				<h3 className="font-medium text-sm">Government IDs</h3>

				<div>
					<form.Field name="ssn">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Social Security Number</Label>
								<Input
									id={field.name}
									name={field.name}
									type="password"
									value={formatSSN(field.state.value)}
									onBlur={field.handleBlur}
									onChange={(e) => handleSSNChange(e.target.value)}
									placeholder="123-45-6789"
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
								<Label htmlFor={field.name}>Passport Number</Label>
								<Input
									id={field.name}
									name={field.name}
									type="password"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="A12345678"
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
								<Label htmlFor={field.name}>Driver's License</Label>
								<Input
									id={field.name}
									name={field.name}
									type="password"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="D12345678"
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
