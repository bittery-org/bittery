/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import { isValidBase32 } from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import {
	Button,
	ButtonGroup,
	Input,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	PasswordGenerator,
	toast,
} from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconPlusOutlineDuo18,
	IconTrash2OutlineDuo18,
	IconXmarkOutlineDuo18,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { nanoid } from "nanoid";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import type { CustomField } from "../types";
import {
	type BaseFormProps,
	FormWrapper,
	NotesField,
	TitleField,
	TotpInputSection,
	type TotpState,
	useFormVault,
} from "./shared";

export interface LoginFormData {
	title: string;
	url: string;
	urls?: string[];
	username: string;
	password: string;
	notes: string;
	customFields?: CustomField[];
	tags?: string[];
	totpSecret?: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

interface LoginFormProps extends BaseFormProps {
	initialData?: Partial<LoginFormData>;
	onSubmit: (data: LoginFormData, vaultId: string) => Promise<void> | void;
}

export function LoginForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: LoginFormProps) {
	const { m } = useI18n();
	const { currentVaultId, setCurrentVaultId } = useFormVault(
		vaults,
		selectedVaultId,
	);
	const [additionalUrls, setAdditionalUrls] = useState<string[]>(
		initialData?.urls || [],
	);
	const [customFields, setCustomFields] = useState<CustomField[]>(
		initialData?.customFields || [],
	);
	const [showPassword, setShowPassword] = useState(false);

	// TOTP state
	const [showTotpSection, setShowTotpSection] = useState<boolean>(
		!!initialData?.totpSecret,
	);
	const [totpState, setTotpState] = useState<TotpState>({
		secret: initialData?.totpSecret || "",
		issuer: initialData?.totpIssuer || "",
		accountName: initialData?.totpAccountName || "",
		algorithm: initialData?.totpAlgorithm || "SHA1",
		digits: initialData?.totpDigits || 6,
		period: initialData?.totpPeriod || 30,
	});
	const [totpSecretError, setTotpSecretError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			url: initialData?.url || "",
			username: initialData?.username || "",
			password: initialData?.password || "",
			notes: initialData?.notes || "",
		},
		onSubmit: async ({ value }) => {
			if (
				showTotpSection &&
				totpState.secret &&
				!isValidBase32(totpState.secret.replace(/\s/g, ""))
			) {
				setTotpSecretError(
					m["vaults.detail.items.form.totp.error.invalid_setup_key"](),
				);
				return;
			}

			try {
				const submitData: LoginFormData = {
					...value,
					urls: additionalUrls.length > 0 ? additionalUrls : undefined,
					customFields: customFields.length > 0 ? customFields : undefined,
					tags: initialData?.tags,
					totpSecret:
						showTotpSection && totpState.secret
							? totpState.secret.replace(/\s/g, "").toUpperCase()
							: undefined,
					totpIssuer:
						showTotpSection && totpState.issuer ? totpState.issuer : undefined,
					totpAccountName:
						showTotpSection && totpState.accountName
							? totpState.accountName
							: undefined,
					totpAlgorithm:
						showTotpSection && totpState.secret
							? totpState.algorithm
							: undefined,
					totpDigits:
						showTotpSection && totpState.secret ? totpState.digits : undefined,
					totpPeriod:
						showTotpSection && totpState.secret ? totpState.period : undefined,
				};

				await onSubmit(submitData, currentVaultId);
			} catch (error) {
				toast.error(m["vaults.detail.items.form.toast.save_item_failed"]());
				console.error(error);
			}
		},
	});

	const handleGeneratePassword = (password: string) => {
		form.setFieldValue("password", password);
	};

	const addAdditionalUrl = () => {
		setAdditionalUrls([...additionalUrls, ""]);
	};

	const updateAdditionalUrl = (index: number, value: string) => {
		const updated = [...additionalUrls];
		updated[index] = value;
		setAdditionalUrls(updated);
	};

	const removeAdditionalUrl = (index: number) => {
		setAdditionalUrls(additionalUrls.filter((_, i) => i !== index));
	};

	const addCustomField = () => {
		setCustomFields([
			...customFields,
			{ id: nanoid(), label: "", value: "", type: "text" },
		]);
	};

	const updateCustomField = (id: string, field: Partial<CustomField>) => {
		setCustomFields(
			customFields.map((cf) => (cf.id === id ? { ...cf, ...field } : cf)),
		);
	};

	const removeCustomField = (id: string) => {
		setCustomFields(customFields.filter((cf) => cf.id !== id));
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
							placeholder={m["vaults.detail.items.form.login.placeholder.title"]()}
						/>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="url">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m["vaults.detail.items.form.login.field.website"]()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								type="url"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m["vaults.detail.items.form.login.placeholder.website"]()}
							/>
							{additionalUrls.map((url, index) => (
								<InputGroup key={index}>
									<InputGroupInput
										type="url"
										value={url}
										onChange={(e) => updateAdditionalUrl(index, e.target.value)}
										placeholder={m["vaults.detail.items.form.login.placeholder.website"]()}
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											type="button"
											size="icon-sm"
											onClick={() => removeAdditionalUrl(index)}
											aria-label={m[
												"vaults.detail.items.form.login.action.remove_website"
											]()}
										>
											<IconXmarkOutlineDuo18 className="size-4" />
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
							))}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-8 text-muted-foreground"
								onClick={addAdditionalUrl}
							>
								<IconPlusOutlineDuo18 className="mr-1 size-3" />
								{m["vaults.detail.items.form.login.action.add_website"]()}
							</Button>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="username">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m["vaults.detail.items.form.login.field.username"]()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m["vaults.detail.items.form.login.placeholder.username"]()}
							/>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="password">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m["vaults.detail.items.form.login.field.password"]()}
							</Label>
							<InputGroup>
								<InputGroupInput
									id={field.name}
									name={field.name}
									type={showPassword ? "text" : "password"}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m["vaults.detail.items.form.login.placeholder.password"]()}
									className="font-mono"
								/>
								<InputGroupAddon align="inline-end">
									<ButtonGroup>
										<InputGroupButton
											type="button"
											size="icon-sm"
											onClick={() => setShowPassword(!showPassword)}
											aria-label={
												showPassword
													? m["vaults.detail.items.form.login.action.hide_password"]()
													: m["vaults.detail.items.form.login.action.show_password"]()
											}
										>
											{showPassword ? (
												<IconEyeSlashOutlineDuo18 className="size-4" />
											) : (
												<IconEyeOutlineDuo18 className="size-4" />
											)}
										</InputGroupButton>
										<PasswordGenerator
											onPasswordGenerated={handleGeneratePassword}
											showCopyButton={false}
											triggerButton={
												<InputGroupButton
													type="button"
													size="icon-sm"
													aria-label={m[
														"vaults.detail.items.form.login.action.generate_password"
													]()}
												>
													<IconCircleKeyOutlineDuo18 className="size-4" />
												</InputGroupButton>
											}
										/>
									</ButtonGroup>
								</InputGroupAddon>
							</InputGroup>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</div>

			{/* Custom Fields */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>{m["vaults.detail.items.form.login.section.custom_fields"]()}</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addCustomField}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						{m["vaults.detail.items.form.login.action.add_custom_field"]()}
					</Button>
				</div>
				{customFields.map((field) => (
					<div key={field.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex gap-2">
							<Input
								placeholder={m[
									"vaults.detail.items.form.login.placeholder.custom_field_label"
								]()}
								value={field.label}
								onChange={(e) =>
									updateCustomField(field.id, { label: e.target.value })
								}
								className="flex-1"
							/>
							<select
								value={field.type}
								onChange={(e) =>
									updateCustomField(field.id, {
										type: e.target.value as CustomField["type"],
									})
								}
								className="rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="text">
									{m["vaults.detail.items.form.login.custom_field_type.text"]()}
								</option>
								<option value="password">
									{m[
										"vaults.detail.items.form.login.custom_field_type.password"
									]()}
								</option>
								<option value="email">
									{m["vaults.detail.items.form.login.custom_field_type.email"]()}
								</option>
								<option value="url">
									{m["vaults.detail.items.form.login.custom_field_type.url"]()}
								</option>
							</select>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={() => removeCustomField(field.id)}
							>
								<IconTrash2OutlineDuo18 size={16} />
							</Button>
						</div>
						<Input
							type={field.type === "password" ? "password" : "text"}
							placeholder={m[
								"vaults.detail.items.form.login.placeholder.custom_field_value"
							]()}
							value={field.value}
							onChange={(e) =>
								updateCustomField(field.id, { value: e.target.value })
							}
						/>
					</div>
				))}
			</div>

			{/* Two-Factor Authentication (TOTP) */}
			<TotpInputSection
				state={totpState}
				onChange={setTotpState}
				showSection={showTotpSection}
				onShowSectionChange={setShowTotpSection}
				secretError={totpSecretError}
				onSecretErrorChange={setTotpSecretError}
			/>
		</FormWrapper>
	);
}
