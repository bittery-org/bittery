import { useI18n } from "@bittery/i18n/react";
import {
	formatSecretForDisplay,
	isValidBase32,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useState } from "react";
import {
	IconClipboardArrowInOutlineDuo18,
	IconKeyOutlineDuo18,
} from "../../../icons";
import { cn } from "../../../lib/utils";
import { Button } from "../../button";
import { Input } from "../../input";
import { Label } from "../../label";
import { toast } from "../../sonner";
import {
	type BaseFormProps,
	FormSection,
	FormWrapper,
	NotesField,
	TitleField,
	TotpAdvancedSettings,
	useFormVault,
} from "./shared";

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

interface TotpFormProps extends BaseFormProps {
	initialData?: Partial<TotpFormData>;
	onSubmit: (data: TotpFormData, vaultId: string) => Promise<void> | void;
}

export function TotpForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel,
	cancelLabel,
	isSubmitting = false,
	vaults = [],
	selectedVaultId,
}: TotpFormProps) {
	const { m } = useI18n();
	const { currentVaultId, setCurrentVaultId } = useFormVault(
		vaults,
		selectedVaultId,
	);
	const [secretError, setSecretError] = useState<string | null>(null);
	const [hasImported, setHasImported] = useState(!!initialData?.totpSecret);

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
			if (!isValidBase32(value.totpSecret)) {
				setSecretError(
					m.vaults_detail_items_form_totp_error_invalid_setup_key(),
				);
				return;
			}

			if (!value.title.trim()) {
				toast.error(m.vaults_detail_items_form_toast_title_required());
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
					tags: initialData?.tags,
				};
				await onSubmit(submitData, currentVaultId);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_form_toast_save_authenticator_failed();
				toast.error(errorMessage);
			}
		},
	});

	const handlePasteFromClipboard = useCallback(
		async (silent = false) => {
			try {
				const text = await navigator.clipboard.readText();
				if (text.startsWith("otpauth://")) {
					const parsed = parseOtpAuthUri(text);

					if (parsed.type !== "totp") {
						if (!silent) {
							toast.error(
								m.vaults_detail_items_totp_toast_only_totp_supported(),
							);
						}
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
					if (!silent) {
						toast.success(
							m.vaults_detail_items_totp_toast_imported_successfully(),
						);
					}
					return true;
				}

				if (isValidBase32(text.replace(/\s/g, ""))) {
					form.setFieldValue("totpSecret", formatSecretForDisplay(text));
					setSecretError(null);
					setHasImported(true);
					if (!silent)
						toast.success(
							m.vaults_detail_items_totp_toast_setup_key_pasted(),
						);
					return true;
				}

				if (!silent) {
					toast.error(
						m.vaults_detail_items_totp_toast_no_valid_setup_in_clipboard(),
					);
				}
				return false;
			} catch {
				if (!silent)
					toast.error(
						m.vaults_detail_items_totp_toast_clipboard_read_failed(),
					);
				return false;
			}
		},
		[form, m],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Only want to run on mount
	useEffect(() => {
		if (!initialData?.totpSecret) {
			handlePasteFromClipboard(true);
		}
	}, []);

	const handleManualEntry = () => {
		setHasImported(true);
	};

	const validateSecret = (value: string) => {
		if (value && !isValidBase32(value.replace(/\s/g, ""))) {
			setSecretError(m.vaults_detail_items_form_totp_error_invalid_format());
		} else {
			setSecretError(null);
		}
	};

	if (!hasImported) {
		return (
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
					<div className="space-y-4">
						<div className="text-center">
							<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-lg border bg-foreground/3 text-foreground shadow-[0_0_20px_color-mix(in_oklab,var(--color-primary-deep)_16%,transparent)] dark:shadow-[0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_28%,transparent)]">
								<IconKeyOutlineDuo18 className="size-6" />
							</div>
							<h3 className="font-semibold text-base">
								{m.vaults_detail_items_form_totp_intro_title()}
							</h3>
							<p className="mt-1 text-muted-foreground text-sm">
								{m.vaults_detail_items_form_totp_intro_description()}
							</p>
						</div>

						<Button
							type="button"
							size="lg"
							className="w-full gap-2"
							onClick={() => handlePasteFromClipboard()}
						>
							<IconClipboardArrowInOutlineDuo18 className="size-5" />
							{m.vaults_detail_items_form_totp_action_paste_from_clipboard()}
						</Button>

						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<span className="w-full border-t" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-popover px-2 text-muted-foreground">
									{m.vaults_detail_items_form_totp_separator_or()}
								</span>
							</div>
						</div>

						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={handleManualEntry}
						>
							{m.vaults_detail_items_form_totp_action_enter_setup_key_manually()}
						</Button>
					</div>

					<div className="rounded-lg border border-dashed p-4">
						<h4 className="font-medium text-sm">
							{m.vaults_detail_items_form_totp_help_title()}
						</h4>
						<ol className="mt-2 list-inside list-decimal space-y-1 text-muted-foreground text-sm">
							<li>{m.vaults_detail_items_form_totp_help_step_1()}</li>
							<li>{m.vaults_detail_items_form_totp_help_step_2()}</li>
							<li>{m.vaults_detail_items_form_totp_help_step_3()}</li>
							<li>{m.vaults_detail_items_form_totp_help_step_4()}</li>
							<li>{m.vaults_detail_items_form_totp_help_step_5()}</li>
						</ol>
					</div>
				</div>

				<div className="flex items-center justify-end gap-3 border-t px-6 py-4">
					<Button type="button" variant="outline" onClick={onCancel}>
						{cancelLabel ?? m.vaults_detail_items_detail_action_cancel()}
					</Button>
				</div>
			</div>
		);
	}

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
							label={m.vaults_detail_items_form_totp_field_name()}
							placeholder={m.vaults_detail_items_form_totp_placeholder_name()}
							autoFocus={!field.state.value}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection>
				<form.Field name="totpSecret">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>
								{m.vaults_detail_items_form_totp_field_setup_key()}
							</Label>
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
									placeholder={m.vaults_detail_items_form_totp_placeholder_setup_key()}
									className={cn(
										"flex-1",
										"font-mono",
										"tracking-wider",
										secretError ? "border-destructive" : "",
									)}
									required
								/>
								<Button
									type="button"
									variant="outline"
									onClick={() => handlePasteFromClipboard()}
									title={m.vaults_detail_items_form_totp_action_paste_from_clipboard()}
								>
									<IconClipboardArrowInOutlineDuo18 size={16} />
									{m.vaults_detail_items_form_totp_action_paste()}
								</Button>
							</div>
							{secretError && (
								<p className="text-destructive text-xs">{secretError}</p>
							)}
						</div>
					)}
				</form.Field>

				<div className="grid grid-cols-2 gap-4">
					<form.Field name="totpIssuer">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_totp_field_service()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_totp_placeholder_service()}
								/>
							</div>
						)}
					</form.Field>

					<form.Field name="totpAccountName">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.vaults_detail_items_form_totp_field_account()}
								</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder={m.vaults_detail_items_form_totp_placeholder_account()}
								/>
							</div>
						)}
					</form.Field>
				</div>

				<form.Field name="totpAlgorithm">
					{(algorithmField) => (
						<form.Field name="totpDigits">
							{(digitsField) => (
								<form.Field name="totpPeriod">
									{(periodField) => (
										<TotpAdvancedSettings
											algorithm={algorithmField.state.value}
											digits={digitsField.state.value}
											period={periodField.state.value}
											onAlgorithmChange={(v) => algorithmField.handleChange(v)}
											onDigitsChange={(v) => digitsField.handleChange(v)}
											onPeriodChange={(v) => periodField.handleChange(v)}
										/>
									)}
								</form.Field>
							)}
						</form.Field>
					)}
				</form.Field>
			</FormSection>

			<FormSection>
				<form.Field name="notes">
					{(field) => (
						<NotesField
							field={field}
							placeholder={m.vaults_detail_items_form_totp_placeholder_notes()}
							rows={2}
						/>
					)}
				</form.Field>
			</FormSection>
		</FormWrapper>
	);
}
