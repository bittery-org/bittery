import {
	isValidBase32,
	type ParsedOtpAuthUri,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import {
	Button,
	FieldError,
	Input,
	Label,
	TextField,
	useToast,
} from "heroui-native";
import {
	Camera,
	ChevronDown,
	ChevronRight,
	ClipboardPaste,
} from "lucide-react-native";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import { QrCodeScanner } from "../qr-code-scanner";
import { TotpDisplay } from "../totp-display";

const StyledCamera = withUniwind(Camera);
const StyledClipboardPaste = withUniwind(ClipboardPaste);
const StyledChevronDown = withUniwind(ChevronDown);
const StyledChevronRight = withUniwind(ChevronRight);

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
		const [showTotpAdvanced, setShowTotpAdvanced] = useState(false);
		const [showQrScanner, setShowQrScanner] = useState(false);

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
				onTitleAutoFill(data.issuer || data.accountName || "TOTP");
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

		return (
			<>
				<QrCodeScanner
					visible={showQrScanner}
					onClose={() => setShowQrScanner(false)}
					onScanSuccess={handleQrScanSuccess}
				/>

				{/* Quick Import Buttons */}
				<View className="mb-4 flex-row gap-2">
					<Button
						onPress={() => setShowQrScanner(true)}
						variant="secondary"
						className="flex-1"
					>
						<StyledCamera size={18} className="text-accent-soft-foreground" />
						<Button.Label>{m.mob_form_totp_scan_qr()}</Button.Label>
					</Button>
					<Button
						onPress={handlePasteTotp}
						variant="secondary"
						className="flex-1"
					>
						<StyledClipboardPaste
							size={18}
							className="text-accent-soft-foreground"
						/>
						<Button.Label>{m.mob_form_totp_paste()}</Button.Label>
					</Button>
				</View>

				{/* Secret Key Input */}
				<TextField
					className="mb-4"
					isRequired
					isInvalid={
						totpSecret && !isValidBase32(totpSecret) ? true : undefined
					}
				>
					<Label>{m.mob_form_totp_secret_label()}</Label>
					<Input
						placeholder={m.mob_form_totp_secret_placeholder()}
						value={totpSecret}
						onChangeText={setTotpSecret}
						autoCapitalize="characters"
						autoCorrect={false}
						className="font-mono"
					/>
					{totpSecret && !isValidBase32(totpSecret) && (
						<FieldError>{m.mob_form_totp_secret_error()}</FieldError>
					)}
				</TextField>

				{/* Live Preview */}
				{totpSecret && isValidBase32(totpSecret) && (
					<View className="mb-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Preview
						</Text>
						<TotpDisplay
							totpSecret={totpSecret}
							totpAlgorithm={totpAlgorithm}
							totpDigits={totpDigits}
							totpPeriod={totpPeriod}
							compact
						/>
					</View>
				)}

				{/* Issuer & Account */}
				<View className="mb-4 flex-row gap-2">
					<TextField className="flex-1">
						<Label>{m.mob_form_totp_service_label()}</Label>
						<Input
							placeholder={m.mob_form_totp_service_placeholder()}
							value={totpIssuer}
							onChangeText={setTotpIssuer}
						/>
					</TextField>

					<TextField className="flex-1">
						<Label>{m.mob_form_totp_account_label()}</Label>
						<Input
							placeholder={m.mob_form_totp_account_placeholder()}
							value={totpAccountName}
							onChangeText={setTotpAccountName}
						/>
					</TextField>
				</View>

				{/* Advanced Settings */}
				<Pressable
					onPress={() => setShowTotpAdvanced(!showTotpAdvanced)}
					className="mb-4 flex-row items-center justify-between rounded-lg border border-border p-3"
				>
					<Text className="font-medium text-foreground text-sm">
						{m.mob_form_totp_advanced_label()}
					</Text>
					{showTotpAdvanced ? (
						<StyledChevronDown size={16} className="text-muted" />
					) : (
						<StyledChevronRight size={16} className="text-muted" />
					)}
				</Pressable>
				{showTotpAdvanced && (
					<View className="mb-4 rounded-lg bg-secondary/30 p-3">
						<View className="mb-4 flex-row gap-2">
							<View className="flex-1">
								<Text className="mb-1 text-muted text-xs">
									{m.mob_form_totp_digits_label()}
								</Text>
								<View className="flex-row rounded-lg border border-input bg-background">
									{[6, 7, 8].map((d) => (
										<Pressable
											key={d}
											onPress={() => setTotpDigits(d as TotpDigits)}
											className={cn(
												"flex-1",
												"items-center",
												"py-2",
												totpDigits === d ? "bg-primary" : "",
											)}
										>
											<Text
												className={cn(
													"text-sm",
													totpDigits === d
														? "text-primary-foreground"
														: "text-foreground",
												)}
											>
												{d}
											</Text>
										</Pressable>
									))}
								</View>
							</View>
							<TextField className="flex-1">
								<Label className="mb-1 text-muted text-xs">
									{m.mob_form_totp_period_label()}
								</Label>
								<Input
									value={totpPeriod.toString()}
									onChangeText={(v: string) =>
										setTotpPeriod(Number.parseInt(v, 10) || 30)
									}
									keyboardType="numeric"
								/>
							</TextField>
						</View>
						<View>
							<Text className="mb-1 text-muted text-xs">
								{m.mob_form_totp_algorithm_label()}
							</Text>
							<View className="flex-row rounded-lg border border-input bg-background">
								{(["SHA1", "SHA256", "SHA512"] as TotpAlgorithm[]).map(
									(algo) => (
										<Pressable
											key={algo}
											onPress={() => setTotpAlgorithm(algo)}
											className={cn(
												"flex-1",
												"items-center",
												"py-2",
												totpAlgorithm === algo ? "bg-primary" : "",
											)}
										>
											<Text
												className={cn(
													"text-xs",
													totpAlgorithm === algo
														? "text-primary-foreground"
														: "text-foreground",
												)}
											>
												{algo}
											</Text>
										</Pressable>
									),
								)}
							</View>
						</View>
					</View>
				)}
			</>
		);
	},
);

TotpForm.displayName = "TotpForm";
