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
import { useForm } from "@tanstack/react-form";
import { Eye, EyeOff, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
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
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: LoginFormProps) {
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
				setTotpSecretError("Invalid setup key. Please check the format.");
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
				toast.success("Item saved successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to save item";
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
			isSubmitting={isSubmitting}
			vaults={vaults}
			currentVaultId={currentVaultId}
			onVaultChange={setCurrentVaultId}
		>
			<div>
				<form.Field name="title">
					{(field) => <TitleField field={field} placeholder="My Account" />}
				</form.Field>
			</div>

			<div>
				<form.Field name="url">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Website</Label>
							<Input
								id={field.name}
								name={field.name}
								type="url"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="https://example.com"
							/>
							{additionalUrls.map((url, index) => (
								<InputGroup key={index}>
									<InputGroupInput
										type="url"
										value={url}
										onChange={(e) => updateAdditionalUrl(index, e.target.value)}
										placeholder="https://example.com"
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											type="button"
											size="icon-sm"
											onClick={() => removeAdditionalUrl(index)}
											aria-label="Remove website"
										>
											<X className="size-4" />
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
								<Plus className="mr-1 size-3" />
								Add another website
							</Button>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="username">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Username</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="user@example.com"
							/>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="password">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Password</Label>
							<InputGroup>
								<InputGroupInput
									id={field.name}
									name={field.name}
									type={showPassword ? "text" : "password"}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="••••••••••"
									className="font-mono"
								/>
								<InputGroupAddon align="inline-end">
									<ButtonGroup>
										<InputGroupButton
											type="button"
											size="icon-sm"
											onClick={() => setShowPassword(!showPassword)}
											aria-label={
												showPassword ? "Hide password" : "Show password"
											}
										>
											{showPassword ? (
												<EyeOff className="size-4" />
											) : (
												<Eye className="size-4" />
											)}
										</InputGroupButton>
										<PasswordGenerator
											onPasswordGenerated={handleGeneratePassword}
											showCopyButton={false}
											triggerButton={
												<InputGroupButton
													type="button"
													size="icon-sm"
													aria-label="Generate password"
												>
													<RefreshCw className="size-4" />
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
					<Label>Custom Fields</Label>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addCustomField}
					>
						<Plus className="mr-1 size-3" />
						Add Field
					</Button>
				</div>
				{customFields.map((field) => (
					<div key={field.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex gap-2">
							<Input
								placeholder="Field label"
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
								<option value="text">Text</option>
								<option value="password">Password</option>
								<option value="email">Email</option>
								<option value="url">URL</option>
							</select>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={() => removeCustomField(field.id)}
							>
								<Trash2 size={16} />
							</Button>
						</div>
						<Input
							type={field.type === "password" ? "password" : "text"}
							placeholder="Value"
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
