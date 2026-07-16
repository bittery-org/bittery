import { useI18n } from "@bittery/i18n/react";
import {
	formatSecretForDisplay,
	isValidBase32,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useCallback } from "react";
import {
	IconClipboardArrowInOutlineDuo18,
	IconPlusOutlineDuo18,
	IconTrash2OutlineDuo18,
} from "../../../../icons";
import { cn } from "../../../../lib/utils";
import { Button } from "../../../button";
import { Input } from "../../../input";
import { Label } from "../../../label";
import { toast } from "../../../sonner";
import { FormAddRow } from "./form-section";
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
	const { m } = useI18n();

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
					if (!silent) {
						toast.success(
							m.vaults_detail_items_totp_toast_imported_successfully(),
						);
					}
					return true;
				}

				if (isValidBase32(text.replace(/\s/g, ""))) {
					onChange({
						...state,
						secret: formatSecretForDisplay(text),
					});
					onSecretErrorChange(null);
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
		[state, onChange, onSecretErrorChange, m],
	);

	const validateSecret = (value: string) => {
		if (value && !isValidBase32(value.replace(/\s/g, ""))) {
			onSecretErrorChange(
				m.vaults_detail_items_form_totp_error_invalid_format(),
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

	if (!showSection) {
		return (
			<FormAddRow onClick={() => onShowSectionChange(true)}>
				<IconPlusOutlineDuo18 className="size-3.5" />
				{m.vaults_detail_items_form_totp_action_add_totp()}
			</FormAddRow>
		);
	}

	return (
		<>
			<div className="space-y-2">
				<Label>
					{m.vaults_detail_items_form_totp_field_setup_key()}
				</Label>
				<div className="flex gap-2">
					<Input
						value={state.secret}
						onChange={(e) => {
							onChange({ ...state, secret: e.target.value });
							validateSecret(e.target.value);
						}}
						onBlur={() => validateSecret(state.secret)}
						placeholder={m.vaults_detail_items_form_totp_placeholder_setup_key()}
						className={cn(
							"flex-1 font-mono tracking-wider",
							secretError ? "border-destructive" : "",
						)}
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

			<div className="grid grid-cols-2 gap-4">
				<div className="space-y-2">
					<Label>
						{m.vaults_detail_items_form_totp_field_service()}
					</Label>
					<Input
						value={state.issuer}
						onChange={(e) => onChange({ ...state, issuer: e.target.value })}
						placeholder={m.vaults_detail_items_form_totp_placeholder_service()}
					/>
				</div>
				<div className="space-y-2">
					<Label>
						{m.vaults_detail_items_form_totp_field_account()}
					</Label>
					<Input
						value={state.accountName}
						onChange={(e) =>
							onChange({ ...state, accountName: e.target.value })
						}
						placeholder={m.vaults_detail_items_form_totp_placeholder_account()}
					/>
				</div>
			</div>

			<TotpAdvancedSettings
				algorithm={state.algorithm}
				digits={state.digits}
				period={state.period}
				onAlgorithmChange={(algorithm) => onChange({ ...state, algorithm })}
				onDigitsChange={(digits) => onChange({ ...state, digits })}
				onPeriodChange={(period) => onChange({ ...state, period })}
			/>

			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={handleRemoveTotp}
				>
					<IconTrash2OutlineDuo18 size={14} className="mr-1" />
					{m.vaults_detail_items_form_totp_action_remove_totp()}
				</Button>
			</div>
		</>
	);
}
