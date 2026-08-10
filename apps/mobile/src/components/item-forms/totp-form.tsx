import {
	isValidBase32,
	type ParsedOtpAuthUri,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { Input, PressableFeedback, useToast } from "heroui-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Text, View } from "react-native";
import {
	type AppIcon,
	IconCamera,
	IconChevronDown,
	IconChevronRight,
	IconClipboardPaste,
	iconSize,
	ListCard,
	SectionLabel,
	Segmented,
	type SegmentedOption,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { QrCodeScanner } from "../qr-code-scanner";
import { TotpDisplay } from "../totp-display";
import { FormField } from "./form-field";

export interface TotpFormData {
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm: TotpAlgorithm;
	totpDigits: TotpDigits;
	totpPeriod: number;
}

export interface TotpFormRef {
	getData: () => TotpFormData;
	isValid: () => boolean;
}

interface TotpFormProps {
	onTitleAutoFill?: (title: string) => void;
	initialData?: Partial<TotpFormData>;
}

const DIGIT_OPTIONS: SegmentedOption<string>[] = [
	{ value: "6", label: "6" },
	{ value: "7", label: "7" },
	{ value: "8", label: "8" },
];

const ALGORITHM_OPTIONS: SegmentedOption<string>[] = [
	{ value: "SHA1", label: "SHA1" },
	{ value: "SHA256", label: "SHA256" },
	{ value: "SHA512", label: "SHA512" },
];

function ImportAction({
	icon: Icon,
	label,
	onPress,
}: {
	icon: AppIcon;
	label: string;
	onPress: () => void;
}) {
	return (
		<PressableFeedback
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-border bg-surface"
		>
			<PressableFeedback.Highlight />
			<Icon size={iconSize.chip} className="text-accent" />
			<Text className="font-medium text-base text-foreground">{label}</Text>
		</PressableFeedback>
	);
}

export const TotpForm = forwardRef<TotpFormRef, TotpFormProps>(
	({ onTitleAutoFill, initialData }, ref) => {
		const { m } = useI18n();
		const { toast } = useToast();
		const [totpSecret, setTotpSecret] = useState(initialData?.totpSecret || "");
		const [totpIssuer, setTotpIssuer] = useState(initialData?.totpIssuer || "");
		const [totpAccountName, setTotpAccountName] = useState(
			initialData?.totpAccountName || "",
		);
		const [totpAlgorithm, setTotpAlgorithm] = useState<TotpAlgorithm>(
			initialData?.totpAlgorithm || "SHA1",
		);
		const [totpDigits, setTotpDigits] = useState<TotpDigits>(
			initialData?.totpDigits || 6,
		);
		const [totpPeriod, setTotpPeriod] = useState(initialData?.totpPeriod || 30);
		const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
		const [isScannerOpen, setIsScannerOpen] = useState(false);

		useImperativeHandle(ref, () => ({
			getData: () => ({
				totpSecret,
				totpIssuer: totpIssuer || undefined,
				totpAccountName: totpAccountName || undefined,
				totpAlgorithm,
				totpDigits,
				totpPeriod,
			}),
			isValid: () => isValidBase32(totpSecret),
		}));

		const handleQrScanSuccess = (data: ParsedOtpAuthUri) => {
			setTotpSecret(data.secret);
			if (data.issuer) setTotpIssuer(data.issuer);
			if (data.accountName) setTotpAccountName(data.accountName);
			if (data.algorithm) setTotpAlgorithm(data.algorithm);
			if (data.digits) setTotpDigits(data.digits);
			if (data.period) setTotpPeriod(data.period);

			// Auto-fill title if callback provided
			if (onTitleAutoFill && (data.issuer || data.accountName)) {
				onTitleAutoFill(
					data.issuer || data.accountName || m.mob_category_totp(),
				);
			}

			toast.show({
				variant: "success",
				label: m.mob_form_totp_toast_imported(),
				placement: "bottom",
			});
		};

		const handlePasteTotp = async () => {
			try {
				const text = await Clipboard.getStringAsync();
				if (!text) {
					toast.show({
						variant: "warning",
						label: m.mob_form_totp_toast_no_clipboard(),
						placement: "bottom",
					});
					return;
				}

				// Check if it's an otpauth:// URI
				if (text.startsWith("otpauth://")) {
					try {
						const parsed = parseOtpAuthUri(text);
						if (isValidBase32(parsed.secret)) {
							handleQrScanSuccess(parsed);
							return;
						}
					} catch {
						// Not a valid URI, try as raw secret
					}
				}

				// Try as raw base32 secret
				const cleanedSecret = text.replace(/\s/g, "").toUpperCase();
				if (isValidBase32(cleanedSecret)) {
					setTotpSecret(cleanedSecret);
					toast.show({
						variant: "success",
						label: m.mob_form_totp_toast_secret_pasted(),
						placement: "bottom",
					});
				} else {
					toast.show({
						variant: "danger",
						label: m.mob_form_totp_toast_invalid_clipboard(),
						placement: "bottom",
					});
				}
			} catch (error) {
				console.error("Error pasting from clipboard:", error);
				toast.show({
					variant: "danger",
					label: m.mob_form_totp_toast_clipboard_failed(),
					placement: "bottom",
				});
			}
		};

		const hasSecretError = Boolean(totpSecret) && !isValidBase32(totpSecret);
		const hasValidSecret = Boolean(totpSecret) && isValidBase32(totpSecret);

		return (
			<>
				<QrCodeScanner
					visible={isScannerOpen}
					onClose={() => setIsScannerOpen(false)}
					onScanSuccess={handleQrScanSuccess}
				/>

				<View className="flex-row gap-3">
					<ImportAction
						icon={IconCamera}
						label={m.mob_form_totp_scan_qr()}
						onPress={() => setIsScannerOpen(true)}
					/>
					<ImportAction
						icon={IconClipboardPaste}
						label={m.mob_form_totp_paste()}
						onPress={handlePasteTotp}
					/>
				</View>

				<FormField
					label={m.mob_form_totp_secret_label()}
					isRequired
					error={hasSecretError ? m.mob_form_totp_secret_error() : null}
				>
					<Input
						placeholder={m.mob_form_totp_secret_placeholder()}
						value={totpSecret}
						onChangeText={setTotpSecret}
						autoCapitalize="characters"
						autoCorrect={false}
						className="font-mono"
					/>
				</FormField>

				{hasValidSecret ? (
					<View>
						<SectionLabel>{m.mob_form_totp_preview_label()}</SectionLabel>
						<ListCard>
							<View className="p-4">
								<TotpDisplay
									totpSecret={totpSecret}
									totpAlgorithm={totpAlgorithm}
									totpDigits={totpDigits}
									totpPeriod={totpPeriod}
									label={totpIssuer || undefined}
								/>
							</View>
						</ListCard>
					</View>
				) : null}

				<View className="flex-row gap-3">
					<FormField label={m.mob_form_totp_service_label()} className="flex-1">
						<Input
							placeholder={m.mob_form_totp_service_placeholder()}
							value={totpIssuer}
							onChangeText={setTotpIssuer}
						/>
					</FormField>

					<FormField label={m.mob_form_totp_account_label()} className="flex-1">
						<Input
							placeholder={m.mob_form_totp_account_placeholder()}
							value={totpAccountName}
							onChangeText={setTotpAccountName}
							autoCapitalize="none"
						/>
					</FormField>
				</View>

				<View>
					<ListCard>
						<PressableFeedback
							onPress={() => setIsAdvancedOpen(!isAdvancedOpen)}
							accessibilityRole="button"
							accessibilityLabel={m.mob_form_totp_advanced_label()}
							className="h-12 flex-row items-center px-4"
						>
							<PressableFeedback.Highlight />
							<Text className="flex-1 font-medium text-base text-foreground">
								{m.mob_form_totp_advanced_label()}
							</Text>
							{isAdvancedOpen ? (
								<IconChevronDown size={iconSize.row} className="text-muted" />
							) : (
								<IconChevronRight size={iconSize.row} className="text-muted" />
							)}
						</PressableFeedback>
						{isAdvancedOpen ? (
							<View className="gap-4 p-4">
								<View>
									<SectionLabel>{m.mob_form_totp_digits_label()}</SectionLabel>
									<Segmented
										options={DIGIT_OPTIONS}
										value={String(totpDigits)}
										onChange={(value) =>
											setTotpDigits(Number(value) as TotpDigits)
										}
									/>
								</View>
								<View>
									<SectionLabel>
										{m.mob_form_totp_algorithm_label()}
									</SectionLabel>
									<Segmented
										options={ALGORITHM_OPTIONS}
										value={totpAlgorithm}
										onChange={(value) =>
											setTotpAlgorithm(value as TotpAlgorithm)
										}
									/>
								</View>
								<FormField label={m.mob_form_totp_period_label()}>
									<Input
										value={String(totpPeriod)}
										onChangeText={(value: string) =>
											setTotpPeriod(Number.parseInt(value, 10) || 30)
										}
										keyboardType="numeric"
										className="font-mono"
									/>
								</FormField>
							</View>
						) : null}
					</ListCard>
				</View>
			</>
		);
	},
);

TotpForm.displayName = "TotpForm";
