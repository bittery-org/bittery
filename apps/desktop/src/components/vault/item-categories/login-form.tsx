/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import {
	formatSecretForDisplay,
	isValidBase32,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
	Label,
	PasswordGenerator,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import {
	ChevronDown,
	ChevronRight,
	Clipboard,
	Plus,
	Settings,
	Smartphone,
	Trash2,
	X,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useState } from "react";
import type { CustomField, VaultOption } from "../types";

export interface LoginFormData {
	title: string;
	url: string;
	urls?: string[];
	username: string;
	password: string;
	notes: string;
	customFields?: CustomField[];
	// TOTP fields - native to login items
	totpSecret?: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

interface LoginFormProps {
	initialData?: Partial<LoginFormData>;
	onSubmit: (data: LoginFormData, vaultId: string) => Promise<void> | void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	selectedVaultId?: string;
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
	console.log(initialData);

	const [additionalUrls, setAdditionalUrls] = useState<string[]>(
		initialData?.urls || [],
	);
	const [customFields, setCustomFields] = useState<CustomField[]>(
		initialData?.customFields || [],
	);
	const [currentVaultId, setCurrentVaultId] = useState<string>(
		selectedVaultId || vaults[0]?.id || "",
	);

	// TOTP state
	const [showTotpSection, setShowTotpSection] = useState<boolean>(
		!!initialData?.totpSecret,
	);
	const [totpSecret, setTotpSecret] = useState<string>(
		initialData?.totpSecret || "",
	);
	const [totpIssuer, setTotpIssuer] = useState<string>(
		initialData?.totpIssuer || "",
	);
	const [totpAccountName, setTotpAccountName] = useState<string>(
		initialData?.totpAccountName || "",
	);
	const [totpAlgorithm, setTotpAlgorithm] = useState<TotpAlgorithm>(
		initialData?.totpAlgorithm || "SHA1",
	);
	const [totpDigits, setTotpDigits] = useState<TotpDigits>(
		initialData?.totpDigits || 6,
	);
	const [totpPeriod, setTotpPeriod] = useState<number>(
		initialData?.totpPeriod || 30,
	);
	const [showTotpAdvanced, setShowTotpAdvanced] = useState(false);
	const [totpSecretError, setTotpSecretError] = useState<string | null>(null);

	const selectedVault = vaults.find((v) => v.id === currentVaultId);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			url: initialData?.url || "",
			username: initialData?.username || "",
			password: initialData?.password || "",
			notes: initialData?.notes || "",
		},
		onSubmit: async ({ value }) => {
			// Validate TOTP secret if provided
			if (
				showTotpSection &&
				totpSecret &&
				!isValidBase32(totpSecret.replace(/\s/g, ""))
			) {
				setTotpSecretError("Invalid setup key. Please check the format.");
				return;
			}

			try {
				const submitData: LoginFormData = {
					...value,
					urls: additionalUrls.length > 0 ? additionalUrls : undefined,
					customFields: customFields.length > 0 ? customFields : undefined,
					// Include TOTP fields if configured
					totpSecret:
						showTotpSection && totpSecret
							? totpSecret.replace(/\s/g, "").toUpperCase()
							: undefined,
					totpIssuer: showTotpSection && totpIssuer ? totpIssuer : undefined,
					totpAccountName:
						showTotpSection && totpAccountName ? totpAccountName : undefined,
					totpAlgorithm:
						showTotpSection && totpSecret ? totpAlgorithm : undefined,
					totpDigits: showTotpSection && totpSecret ? totpDigits : undefined,
					totpPeriod: showTotpSection && totpSecret ? totpPeriod : undefined,
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

	// TOTP helper functions
	const handleTotpPasteFromClipboard = useCallback(async (silent = false) => {
		try {
			const text = await navigator.clipboard.readText();
			if (text.startsWith("otpauth://")) {
				const parsed = parseOtpAuthUri(text);

				if (parsed.type !== "totp") {
					if (!silent) toast.error("Only TOTP codes are supported");
					return false;
				}

				setTotpSecret(formatSecretForDisplay(parsed.secret));
				if (parsed.issuer) {
					setTotpIssuer(parsed.issuer);
				}
				if (parsed.accountName) {
					setTotpAccountName(parsed.accountName);
				}
				if (parsed.algorithm) {
					setTotpAlgorithm(parsed.algorithm);
				}
				if (parsed.digits) {
					setTotpDigits(parsed.digits);
				}
				if (parsed.period) {
					setTotpPeriod(parsed.period);
				}

				setTotpSecretError(null);
				if (!silent) toast.success("2FA setup imported successfully!");
				return true;
			}

			if (isValidBase32(text.replace(/\s/g, ""))) {
				// Plain secret key
				setTotpSecret(formatSecretForDisplay(text));
				setTotpSecretError(null);
				if (!silent) toast.success("Setup key pasted!");
				return true;
			}

			if (!silent) {
				toast.error("No valid 2FA setup found in clipboard");
			}
			return false;
		} catch {
			if (!silent) toast.error("Unable to read clipboard");
			return false;
		}
	}, []);

	const validateTotpSecret = (value: string) => {
		if (value && !isValidBase32(value.replace(/\s/g, ""))) {
			setTotpSecretError(
				"Invalid format - should be letters A-Z and numbers 2-7",
			);
		} else {
			setTotpSecretError(null);
		}
	};

	const handleRemoveTotp = () => {
		setShowTotpSection(false);
		setTotpSecret("");
		setTotpIssuer("");
		setTotpAccountName("");
		setTotpAlgorithm("SHA1");
		setTotpDigits(6);
		setTotpPeriod(30);
		setTotpSecretError(null);
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
									placeholder="My Account"
									required
								/>
							</div>
						)}
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
								<div className="flex gap-2">
									<Input
										id={field.name}
										name={field.name}
										type="password"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="••••••••••"
										className="flex-1 font-mono"
									/>
									<PasswordGenerator
										onPasswordGenerated={handleGeneratePassword}
										showCopyButton={false}
									/>
								</div>
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

				{/* Additional URLs */}
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label>Additional Websites</Label>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={addAdditionalUrl}
						>
							<Plus className="mr-1 size-3" />
							Add URL
						</Button>
					</div>
					{additionalUrls.map((url, index) => (
						<div key={index} className="flex gap-2">
							<Input
								type="url"
								value={url}
								onChange={(e) => updateAdditionalUrl(index, e.target.value)}
								placeholder="https://example.com"
								className="flex-1"
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={() => removeAdditionalUrl(index)}
							>
								<X size={16} />
							</Button>
						</div>
					))}
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
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label className="flex items-center gap-2">
							<Smartphone className="size-4" />
							Two-Factor Authentication
						</Label>
						{!showTotpSection && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setShowTotpSection(true)}
							>
								<Plus className="mr-1 size-3" />
								Add TOTP
							</Button>
						)}
					</div>

					{showTotpSection && (
						<div className="space-y-4 rounded-lg border p-4">
							{/* Setup Key */}
							<div className="space-y-2">
								<Label>Setup Key *</Label>
								<div className="flex gap-2">
									<Input
										value={totpSecret}
										onChange={(e) => {
											setTotpSecret(e.target.value);
											validateTotpSecret(e.target.value);
										}}
										onBlur={() => validateTotpSecret(totpSecret)}
										placeholder="XXXX XXXX XXXX XXXX"
										className={`flex-1 font-mono tracking-wider ${totpSecretError ? "border-destructive" : ""}`}
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => handleTotpPasteFromClipboard()}
										title="Paste from clipboard"
									>
										<Clipboard size={16} className="mr-2" />
										Paste
									</Button>
								</div>
								{totpSecretError && (
									<p className="text-destructive text-sm">{totpSecretError}</p>
								)}
							</div>

							{/* Account info */}
							<div className="grid grid-cols-2 gap-4">
								<div className="space-y-2">
									<Label>Service</Label>
									<Input
										value={totpIssuer}
										onChange={(e) => setTotpIssuer(e.target.value)}
										placeholder="Google, GitHub, etc."
									/>
								</div>
								<div className="space-y-2">
									<Label>Account</Label>
									<Input
										value={totpAccountName}
										onChange={(e) => setTotpAccountName(e.target.value)}
										placeholder="your@email.com"
									/>
								</div>
							</div>

							{/* Advanced settings - collapsed by default */}
							<div className="rounded-lg border">
								<button
									type="button"
									onClick={() => setShowTotpAdvanced(!showTotpAdvanced)}
									className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/50"
								>
									<div className="flex items-center gap-2">
										<Settings className="size-4 text-muted-foreground" />
										<span className="font-medium text-sm">
											Advanced Settings
										</span>
									</div>
									{showTotpAdvanced ? (
										<ChevronDown className="size-4 text-muted-foreground" />
									) : (
										<ChevronRight className="size-4 text-muted-foreground" />
									)}
								</button>

								{showTotpAdvanced && (
									<div className="border-t p-4">
										<p className="mb-4 text-muted-foreground text-xs">
											Most services use the default settings. Only change these
											if your service specifies different values.
										</p>
										<div className="grid grid-cols-3 gap-4">
											<div className="space-y-2">
												<Label>Algorithm</Label>
												<select
													value={totpAlgorithm}
													onChange={(e) =>
														setTotpAlgorithm(e.target.value as TotpAlgorithm)
													}
													className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
												>
													<option value="SHA1">SHA-1 (default)</option>
													<option value="SHA256">SHA-256</option>
													<option value="SHA512">SHA-512</option>
												</select>
											</div>
											<div className="space-y-2">
												<Label>Code Length</Label>
												<select
													value={totpDigits}
													onChange={(e) =>
														setTotpDigits(Number(e.target.value) as TotpDigits)
													}
													className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
												>
													<option value={6}>6 digits (default)</option>
													<option value={7}>7 digits</option>
													<option value={8}>8 digits</option>
												</select>
											</div>
											<div className="space-y-2">
												<Label>Refresh (sec)</Label>
												<Input
													type="number"
													min={15}
													max={120}
													value={totpPeriod}
													onChange={(e) =>
														setTotpPeriod(Number(e.target.value))
													}
												/>
											</div>
										</div>
									</div>
								)}
							</div>

							{/* Remove TOTP button */}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-destructive hover:bg-destructive/10 hover:text-destructive"
								onClick={handleRemoveTotp}
							>
								<Trash2 size={14} className="mr-1" />
								Remove TOTP
							</Button>
						</div>
					)}
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
