import { useI18n } from "@bittery/i18n/react";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useState } from "react";
import {
	IconSettings,
	IconChevronDown,
	IconChevronRight,
} from "../../../../icons";
import { Input } from "../../../input";
import { Label } from "../../../label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../../select";

interface TotpAdvancedSettingsProps {
	algorithm: TotpAlgorithm;
	digits: TotpDigits;
	period: number;
	onAlgorithmChange: (algorithm: TotpAlgorithm) => void;
	onDigitsChange: (digits: TotpDigits) => void;
	onPeriodChange: (period: number) => void;
	defaultExpanded?: boolean;
}

export function TotpAdvancedSettings({
	algorithm,
	digits,
	period,
	onAlgorithmChange,
	onDigitsChange,
	onPeriodChange,
	defaultExpanded = false,
}: TotpAdvancedSettingsProps) {
	const { m } = useI18n();
	const [showAdvanced, setShowAdvanced] = useState(defaultExpanded);

	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			<button
				type="button"
				onClick={() => setShowAdvanced(!showAdvanced)}
				className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-foreground/4 focus-visible:bg-foreground/4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:ring-inset"
			>
				<div className="flex items-center gap-2">
					<IconSettings className="size-4 text-muted-foreground" />
					<span className="font-medium text-sm">
						{m.vaults_detail_items_totp_settings_title()}
					</span>
				</div>
				{showAdvanced ? (
					<IconChevronDown className="size-4 text-muted-foreground" />
				) : (
					<IconChevronRight className="size-4 text-muted-foreground" />
				)}
			</button>

			{showAdvanced && (
				<div className="border-t p-3">
					<p className="mb-3 text-muted-foreground text-xs">
						{m.vaults_detail_items_totp_settings_description()}
					</p>
					<div className="grid grid-cols-3 gap-3">
						<div className="space-y-2">
							<Label>
								{m.vaults_detail_items_totp_settings_field_algorithm()}
							</Label>
							<Select
								value={algorithm}
								onValueChange={(value) =>
									onAlgorithmChange(value as TotpAlgorithm)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="SHA1">
										{m.vaults_detail_items_totp_settings_option_algorithm_sha1()}
									</SelectItem>
									<SelectItem value="SHA256">
										{m.vaults_detail_items_totp_settings_option_algorithm_sha256()}
									</SelectItem>
									<SelectItem value="SHA512">
										{m.vaults_detail_items_totp_settings_option_algorithm_sha512()}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label>
								{m.vaults_detail_items_totp_settings_field_code_length()}
							</Label>
							<Select
								value={String(digits)}
								onValueChange={(value) =>
									onDigitsChange(Number(value) as TotpDigits)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="6">
										{m.vaults_detail_items_totp_settings_option_digits_6()}
									</SelectItem>
									<SelectItem value="7">
										{m.vaults_detail_items_totp_settings_option_digits_7()}
									</SelectItem>
									<SelectItem value="8">
										{m.vaults_detail_items_totp_settings_option_digits_8()}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label>
								{m.vaults_detail_items_totp_settings_field_refresh()}
							</Label>
							<Input
								type="number"
								min={15}
								max={120}
								value={period}
								onChange={(e) => onPeriodChange(Number(e.target.value))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
