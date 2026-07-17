/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import { useI18n } from "@bittery/i18n/react";
import { isValidBase32 } from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useForm } from "@tanstack/react-form";
import { nanoid } from "nanoid";
import { useState } from "react";
import {
	IconPasskey,
	IconEye,
	IconEyeOff,
	IconPlus,
	IconTrash,
	IconX,
} from "../../../icons";
import { Button } from "../../button";
import { ButtonGroup } from "../../button-group";
import { Input } from "../../input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "../../input-group";
import { Label } from "../../label";
import { PasswordGenerator } from "../../password-generator";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../select";
import { toast } from "../../sonner";
import type { CustomField } from "../types";
import {
	type BaseFormProps,
	FormAddRow,
	FormSection,
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
	cancelLabel,
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
					m.vaults_detail_items_form_totp_error_invalid_setup_key(),
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
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_form_toast_save_item_failed();
				toast.error(errorMessage);
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
							placeholder={m.vaults_detail_items_form_login_placeholder_title()}
							autoFocus={!field.state.value}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection label={m.vaults_detail_items_form_login_section_credentials()}>
				<form.Field name="username">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_login_field_username()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_login_placeholder_username()}
							/>
						</div>
					)}
				</form.Field>

				<form.Field name="password">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_login_field_password()}
							</Label>
							<InputGroup>
								<InputGroupInput
									id={field.name}
									name={field.name}
									type={showPassword ? "text" : "password"}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_login_placeholder_password()}
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
													? m.vaults_detail_items_form_login_action_hide_password()
													: m.vaults_detail_items_form_login_action_show_password()
											}
										>
											{showPassword ? (
												<IconEyeOff className="size-4" />
											) : (
												<IconEye className="size-4" />
											)}
										</InputGroupButton>
										<PasswordGenerator
											onPasswordGenerated={handleGeneratePassword}
											showCopyButton={false}
											triggerButton={
												<InputGroupButton
													type="button"
													size="icon-sm"
													aria-label={m.vaults_detail_items_form_login_action_generate_password()}
												>
													<IconPasskey className="size-4" />
												</InputGroupButton>
											}
										/>
									</ButtonGroup>
								</InputGroupAddon>
							</InputGroup>
						</div>
					)}
				</form.Field>
			</FormSection>

			<FormSection label={m.vaults_detail_items_form_login_section_websites()}>
				<form.Field name="url">
					{(field) => (
						<div className="space-y-2">
							<Input
								id={field.name}
								name={field.name}
								type="url"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder={m.vaults_detail_items_form_login_placeholder_website()}
								aria-label={m.vaults_detail_items_form_login_field_website()}
							/>
							{additionalUrls.map((url, index) => (
								<InputGroup key={index}>
									<InputGroupInput
										type="url"
										value={url}
										onChange={(e) => updateAdditionalUrl(index, e.target.value)}
										placeholder={m.vaults_detail_items_form_login_placeholder_website()}
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											type="button"
											size="icon-sm"
											onClick={() => removeAdditionalUrl(index)}
											aria-label={m.vaults_detail_items_form_login_action_remove_website()}
										>
											<IconX className="size-4" />
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
							))}
							<FormAddRow onClick={addAdditionalUrl}>
								<IconPlus className="size-3.5" />
								{m.vaults_detail_items_form_login_action_add_website()}
							</FormAddRow>
						</div>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_totp_section_two_factor_authentication()}
			>
				<TotpInputSection
					state={totpState}
					onChange={setTotpState}
					showSection={showTotpSection}
					onShowSectionChange={setShowTotpSection}
					secretError={totpSecretError}
					onSecretErrorChange={setTotpSecretError}
				/>
			</FormSection>

			<FormSection
				label={m.vaults_detail_items_form_login_section_custom_fields()}
			>
				{customFields.length > 0 && (
					<div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border bg-card">
						{customFields.map((field) => (
							<div key={field.id} className="space-y-2 p-3">
								<div className="flex items-center gap-2">
									<Input
										placeholder={m.vaults_detail_items_form_login_placeholder_custom_field_label()}
										value={field.label}
										onChange={(e) =>
											updateCustomField(field.id, { label: e.target.value })
										}
										className="flex-1"
									/>
									<Select
										value={field.type}
										onValueChange={(value) =>
											updateCustomField(field.id, {
												type: value as CustomField["type"],
											})
										}
									>
										<SelectTrigger className="w-32 shrink-0">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="text">
												{m.vaults_detail_items_form_login_custom_field_type_text()}
											</SelectItem>
											<SelectItem value="password">
												{m.vaults_detail_items_form_login_custom_field_type_password()}
											</SelectItem>
											<SelectItem value="email">
												{m.vaults_detail_items_form_login_custom_field_type_email()}
											</SelectItem>
											<SelectItem value="url">
												{m.vaults_detail_items_form_login_custom_field_type_url()}
											</SelectItem>
										</SelectContent>
									</Select>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
										onClick={() => removeCustomField(field.id)}
										aria-label={m.vaults_detail_items_form_login_action_remove_custom_field()}
									>
										<IconTrash size={16} />
									</Button>
								</div>
								<Input
									type={field.type === "password" ? "password" : "text"}
									placeholder={m.vaults_detail_items_form_login_placeholder_custom_field_value()}
									value={field.value}
									onChange={(e) =>
										updateCustomField(field.id, { value: e.target.value })
									}
								/>
							</div>
						))}
					</div>
				)}
				<FormAddRow onClick={addCustomField}>
					<IconPlus className="size-3.5" />
					{m.vaults_detail_items_form_login_action_add_custom_field()}
				</FormAddRow>
			</FormSection>

			<FormSection>
				<form.Field name="notes">
					{(field) => <NotesField field={field} />}
				</form.Field>
			</FormSection>
		</FormWrapper>
	);
}
