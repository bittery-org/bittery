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
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import {
	ChevronDown,
	ChevronRight,
	Clipboard,
	Key,
	Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { VaultOption } from "../types";

export interface TotpFormData {
	title: string;
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm: TotpAlgorithm;
	totpDigits: TotpDigits;
	totpPeriod: number;
	notes?: string;
	tags?: string[];
}

interface TotpFormProps {
	initialData?: Partial<TotpFormData>;
	onSubmit: (data: TotpFormData, vaultId: string) => Promise<void> | void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
	vaults?: VaultOption[];
	selectedVaultId?: string;
}

export function TotpForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: TotpFormProps) {
	const [currentVaultId, setCurrentVaultId] = useState<string>(
		selectedVaultId || vaults[0]?.id || "",
	);
	const [secretError, setSecretError] = useState<string | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [hasImported, setHasImported] = useState(!!initialData?.totpSecret);

	const selectedVault = vaults.find((v) => v.id === currentVaultId);

	const form = useForm({
		defaultValues: {
			title: initialData?.title || "",
			totpSecret: initialData?.totpSecret || "",
			totpIssuer: initialData?.totpIssuer || "",
			totpAccountName: initialData?.totpAccountName || "",
			totpAlgorithm: initialData?.totpAlgorithm || ("SHA1" as TotpAlgorithm),
			totpDigits: initialData?.totpDigits || (6 as TotpDigits),
			totpPeriod: initialData?.totpPeriod || 30,
			notes: initialData?.notes || "",
		},
		onSubmit: async ({ value }) => {
			// Validate secret before submission
			if (!isValidBase32(value.totpSecret)) {
				setSecretError("Invalid setup key. Please check the format.");
				return;
			}

			if (!value.title.trim()) {
				toast.error("Please enter a title");
				return;
			}

			try {
				const submitData: TotpFormData = {
					title: value.title,
					totpSecret: value.totpSecret.replace(/\s/g, "").toUpperCase(),
					totpIssuer: value.totpIssuer || undefined,
					totpAccountName: value.totpAccountName || undefined,
					totpAlgorithm: value.totpAlgorithm,
					totpDigits: value.totpDigits,
					totpPeriod: value.totpPeriod,
					notes: value.notes || undefined,
					// Preserve existing tags from initialData (tags are edited in detail view)
					tags: initialData?.tags,
				};
				await onSubmit(submitData, currentVaultId);
				toast.success("Authenticator saved successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "Failed to save authenticator";
				toast.error(errorMessage);
			}
		},
	});

	// Auto-focus paste on mount if no initial data
	// biome-ignore lint/correctness/useExhaustiveDependencies: Only want to run on mount
	useEffect(() => {
		if (!initialData?.totpSecret) {
			// Try to auto-paste from clipboard on mount
			handlePasteFromClipboard(true);
		}
	}, []);

	const handlePasteFromClipboard = useCallback(
		async (silent = false) => {
			try {
				const text = await navigator.clipboard.readText();
				if (text.startsWith("otpauth://")) {
					const parsed = parseOtpAuthUri(text);

					if (parsed.type !== "totp") {
						if (!silent) toast.error("Only TOTP codes are supported");
						return false;
					}

					form.setFieldValue(
						"totpSecret",
						formatSecretForDisplay(parsed.secret),
					);
					if (parsed.issuer) {
						form.setFieldValue("totpIssuer", parsed.issuer);
					}
					if (parsed.accountName) {
						form.setFieldValue("totpAccountName", parsed.accountName);
					}

					// Auto-generate title
					const title =
						parsed.issuer && parsed.accountName
							? `${parsed.issuer} (${parsed.accountName})`
							: parsed.issuer || parsed.accountName || "";
					if (title) {
						form.setFieldValue("title", title);
					}

					if (parsed.algorithm) {
						form.setFieldValue("totpAlgorithm", parsed.algorithm);
					}
					if (parsed.digits) {
						form.setFieldValue("totpDigits", parsed.digits);
					}
					if (parsed.period) {
						form.setFieldValue("totpPeriod", parsed.period);
					}

					setSecretError(null);
					setHasImported(true);
					if (!silent) toast.success("2FA setup imported successfully!");
					return true;
				}

				if (isValidBase32(text.replace(/\s/g, ""))) {
					// Plain secret key
					form.setFieldValue("totpSecret", formatSecretForDisplay(text));
					setSecretError(null);
					setHasImported(true);
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
		},
		[form],
	);

	const handleManualEntry = () => {
		setHasImported(true);
	};

	const validateSecret = (value: string) => {
		if (value && !isValidBase32(value.replace(/\s/g, ""))) {
			setSecretError("Invalid format - should be letters A-Z and numbers 2-7");
		} else {
			setSecretError(null);
		}
	};

	// Initial state - show easy import options
	if (!hasImported) {
		return (
			<div className="flex flex-1 flex-col overflow-hidden">
				<div className="flex-1 space-y-6 overflow-y-auto py-1 pr-2">
					{/* Quick Import Section */}
					<div className="space-y-4">
						<div className="text-center">
							<div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-primary/10">
								<Key className="size-8 text-primary" />
							</div>
							<h3 className="font-semibold text-lg">Add Authenticator</h3>
							<p className="mt-1 text-muted-foreground text-sm">
								Copy the setup key or QR code link from your account's 2FA
								settings
							</p>
						</div>

						{/* Primary action - Paste */}
						<Button
							type="button"
							size="lg"
							className="w-full gap-2"
							onClick={() => handlePasteFromClipboard()}
						>
							<Clipboard className="size-5" />
							Paste from Clipboard
						</Button>

						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<span className="w-full border-t" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-background px-2 text-muted-foreground">
									or
								</span>
							</div>
						</div>

						{/* Manual entry option */}
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={handleManualEntry}
						>
							Enter Setup Key Manually
						</Button>
					</div>

					{/* Help text */}
					<div className="rounded-lg border border-dashed p-4">
						<h4 className="font-medium text-sm">How to find your setup key:</h4>
						<ol className="mt-2 list-inside list-decimal space-y-1 text-muted-foreground text-sm">
							<li>Go to your account's security settings</li>
							<li>Look for "Two-Factor Authentication" or "2FA"</li>
							<li>Choose "Authenticator app" as your method</li>
							<li>Copy the setup key (or scan the QR code)</li>
							<li>Paste it here using the button above</li>
						</ol>
					</div>
				</div>

				{/* Footer */}
				<div className="mt-4 flex items-center justify-end gap-3 border-t bg-background pt-4">
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	// Form view - after import or manual entry
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
			className="flex flex-1 flex-col overflow-hidden"
		>
			<div className="flex-1 space-y-4 overflow-y-auto py-1 pr-2">
				{/* Title */}
				<div>
					<form.Field name="title">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Name *</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g., Google, GitHub, Amazon"
									autoFocus={!field.state.value}
									required
								/>
							</div>
						)}
					</form.Field>
				</div>

				{/* Setup Key */}
				<div>
					<form.Field name="totpSecret">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Setup Key *</Label>
								<div className="flex gap-2">
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={() => {
											field.handleBlur();
											validateSecret(field.state.value);
										}}
										onChange={(e) => {
											field.handleChange(e.target.value);
											validateSecret(e.target.value);
										}}
										placeholder="XXXX XXXX XXXX XXXX"
										className={`flex-1 font-mono tracking-wider ${secretError ? "border-destructive" : ""}`}
										required
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => handlePasteFromClipboard()}
										title="Paste from clipboard"
									>
										<Clipboard size={16} className="mr-2" />
										Paste
									</Button>
								</div>
								{secretError && (
									<p className="text-destructive text-sm">{secretError}</p>
								)}
							</div>
						)}
					</form.Field>
				</div>

				{/* Account info - simplified */}
				<div className="grid grid-cols-2 gap-4">
					<div>
						<form.Field name="totpIssuer">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Service</Label>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="Google, GitHub, etc."
									/>
								</div>
							)}
						</form.Field>
					</div>

					<div>
						<form.Field name="totpAccountName">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Account</Label>
									<Input
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="your@email.com"
									/>
								</div>
							)}
						</form.Field>
					</div>
				</div>

				{/* Advanced settings - collapsed by default */}
				<div className="rounded-lg border">
					<button
						type="button"
						onClick={() => setShowAdvanced(!showAdvanced)}
						className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/50"
					>
						<div className="flex items-center gap-2">
							<Settings className="size-4 text-muted-foreground" />
							<span className="font-medium text-sm">Advanced Settings</span>
						</div>
						{showAdvanced ? (
							<ChevronDown className="size-4 text-muted-foreground" />
						) : (
							<ChevronRight className="size-4 text-muted-foreground" />
						)}
					</button>

					{showAdvanced && (
						<div className="border-t p-4">
							<p className="mb-4 text-muted-foreground text-xs">
								Most services use the default settings. Only change these if
								your service specifies different values.
							</p>
							<div className="grid grid-cols-3 gap-4">
								<div>
									<form.Field name="totpAlgorithm">
										{(field) => (
											<div className="space-y-2">
												<Label htmlFor={field.name}>Algorithm</Label>
												<select
													id={field.name}
													name={field.name}
													value={field.state.value}
													onBlur={field.handleBlur}
													onChange={(e) =>
														field.handleChange(e.target.value as TotpAlgorithm)
													}
													className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
												>
													<option value="SHA1">SHA-1 (default)</option>
													<option value="SHA256">SHA-256</option>
													<option value="SHA512">SHA-512</option>
												</select>
											</div>
										)}
									</form.Field>
								</div>

								<div>
									<form.Field name="totpDigits">
										{(field) => (
											<div className="space-y-2">
												<Label htmlFor={field.name}>Code Length</Label>
												<select
													id={field.name}
													name={field.name}
													value={field.state.value}
													onBlur={field.handleBlur}
													onChange={(e) =>
														field.handleChange(
															Number(e.target.value) as TotpDigits,
														)
													}
													className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
												>
													<option value={6}>6 digits (default)</option>
													<option value={7}>7 digits</option>
													<option value={8}>8 digits</option>
												</select>
											</div>
										)}
									</form.Field>
								</div>

								<div>
									<form.Field name="totpPeriod">
										{(field) => (
											<div className="space-y-2">
												<Label htmlFor={field.name}>Refresh (sec)</Label>
												<Input
													id={field.name}
													name={field.name}
													type="number"
													min={15}
													max={120}
													value={field.state.value}
													onBlur={field.handleBlur}
													onChange={(e) =>
														field.handleChange(Number(e.target.value))
													}
												/>
											</div>
										)}
									</form.Field>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Notes */}
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
									placeholder="Backup codes, recovery info, etc."
									rows={2}
									className="flex min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								/>
							</div>
						)}
					</form.Field>
				</div>
			</div>

			{/* Footer with Vault Selector */}
			<div className="mt-4 flex items-center justify-between gap-3 border-t bg-background pt-4">
				{vaults.length > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								{selectedVault ? (
									<>
										{(selectedVault.accountTeamName ||
											selectedVault.accountName) && (
											<span className="text-muted-foreground">
												{selectedVault.accountTeamName ||
													selectedVault.accountName}{" "}
												/{" "}
											</span>
										)}
										{selectedVault.name}
									</>
								) : (
									"Select vault"
								)}
								<ChevronDown className="ml-2 size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{vaults.map((vault) => (
								<DropdownMenuItem
									key={vault.id}
									onClick={() => setCurrentVaultId(vault.id)}
								>
									<div className="flex flex-col">
										<div>
											{(vault.accountTeamName || vault.accountName) && (
												<span className="text-muted-foreground text-xs">
													{vault.accountTeamName || vault.accountName} /{" "}
												</span>
											)}
											<span>{vault.name}</span>
										</div>
									</div>
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
