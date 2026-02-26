import {
	formatSecretForDisplay,
	isValidBase32,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { Button, cn, Input, Label, toast } from "@bittery/ui";
import {
	IconClipboardArrowInOutlineDuo18,
	IconMobileOutlineDuo18,
	IconPlusOutlineDuo18,
	IconTrash2OutlineDuo18,
} from "@bittery/ui/icons";
import { useCallback } from "react";
import { TotpAdvancedSettings } from "./totp-settings";

export interface TotpState {
	secret: string;
	issuer: string;
	accountName: string;
	algorithm: TotpAlgorithm;
	digits: TotpDigits;
	period: number;
}

interface TotpInputSectionProps {
	state: TotpState;
	onChange: (state: TotpState) => void;
	showSection: boolean;
	onShowSectionChange: (show: boolean) => void;
	secretError: string | null;
	onSecretErrorChange: (error: string | null) => void;
}

export function TotpInputSection({
	state,
	onChange,
	showSection,
	onShowSectionChange,
	secretError,
	onSecretErrorChange,
}: TotpInputSectionProps) {
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

					onChange({
						...state,
						secret: formatSecretForDisplay(parsed.secret),
						issuer: parsed.issuer || state.issuer,
						accountName: parsed.accountName || state.accountName,
						algorithm: parsed.algorithm || state.algorithm,
						digits: parsed.digits || state.digits,
						period: parsed.period || state.period,
					});

					onSecretErrorChange(null);
					if (!silent) toast.success("2FA setup imported successfully!");
					return true;
				}

				if (isValidBase32(text.replace(/\s/g, ""))) {
					onChange({
						...state,
						secret: formatSecretForDisplay(text),
					});
					onSecretErrorChange(null);
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
		[state, onChange, onSecretErrorChange],
	);

	const validateSecret = (value: string) => {
		if (value && !isValidBase32(value.replace(/\s/g, ""))) {
			onSecretErrorChange(
				"Invalid format - should be letters A-Z and numbers 2-7",
			);
		} else {
			onSecretErrorChange(null);
		}
	};

	const handleRemoveTotp = () => {
		onShowSectionChange(false);
		onChange({
			secret: "",
			issuer: "",
			accountName: "",
			algorithm: "SHA1",
			digits: 6,
			period: 30,
		});
		onSecretErrorChange(null);
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="flex items-center gap-2">
					<IconMobileOutlineDuo18 className="size-4" />
					Two-Factor Authentication
				</Label>
				{!showSection && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onShowSectionChange(true)}
					>
						<IconPlusOutlineDuo18 className="mr-1 size-3" />
						Add TOTP
					</Button>
				)}
			</div>

			{showSection && (
				<div className="space-y-4 rounded-lg border p-4">
					{/* Setup Key */}
					<div className="space-y-2">
						<Label>Setup Key *</Label>
						<div className="flex gap-2">
							<Input
								value={state.secret}
								onChange={(e) => {
									onChange({ ...state, secret: e.target.value });
									validateSecret(e.target.value);
								}}
								onBlur={() => validateSecret(state.secret)}
								placeholder="XXXX XXXX XXXX XXXX"
								className={cn(
									"flex-1",
									"font-mono",
									"tracking-wider",
									secretError ? "border-destructive" : "",
								)}
							/>
							<Button
								type="button"
								variant="outline"
								onClick={() => handlePasteFromClipboard()}
								title="Paste from clipboard"
							>
								<IconClipboardArrowInOutlineDuo18 size={16} />
								Paste
							</Button>
						</div>
						{secretError && (
							<p className="text-destructive text-sm">{secretError}</p>
						)}
					</div>

					{/* Account info */}
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label>Service</Label>
							<Input
								value={state.issuer}
								onChange={(e) => onChange({ ...state, issuer: e.target.value })}
								placeholder="Google, GitHub, etc."
							/>
						</div>
						<div className="space-y-2">
							<Label>Account</Label>
							<Input
								value={state.accountName}
								onChange={(e) =>
									onChange({ ...state, accountName: e.target.value })
								}
								placeholder="your@email.com"
							/>
						</div>
					</div>

					{/* Advanced settings */}
					<TotpAdvancedSettings
						algorithm={state.algorithm}
						digits={state.digits}
						period={state.period}
						onAlgorithmChange={(algorithm) => onChange({ ...state, algorithm })}
						onDigitsChange={(digits) => onChange({ ...state, digits })}
						onPeriodChange={(period) => onChange({ ...state, period })}
					/>

					{/* Remove TOTP button */}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={handleRemoveTotp}
					>
						<IconTrash2OutlineDuo18 size={14} className="mr-1" />
						Remove TOTP
					</Button>
				</div>
			)}
		</div>
	);
}
