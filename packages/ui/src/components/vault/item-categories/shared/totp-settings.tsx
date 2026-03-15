import { useI18n } from "@bittery/i18n/react";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { useState } from "react";
import {
	IconGear3OutlineDuo18,
	IconVShapedArrowDownOutlineDuo18,
	IconVShapedArrowRightOutlineDuo18,
} from "../../../../icons";
import { Input } from "../../../input";
import { Label } from "../../../label";

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
		<div className="rounded-lg border">
			<button
				type="button"
				onClick={() => setShowAdvanced(!showAdvanced)}
				className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/50"
			>
				<div className="flex items-center gap-2">
					<IconGear3OutlineDuo18 className="size-4 text-muted-foreground" />
					<span className="font-medium text-sm">
						{m.vaults_detail_items_totp_settings_title()}
					</span>
				</div>
				{showAdvanced ? (
					<IconVShapedArrowDownOutlineDuo18 className="size-4 text-muted-foreground" />
				) : (
					<IconVShapedArrowRightOutlineDuo18 className="size-4 text-muted-foreground" />
				)}
			</button>

			{showAdvanced && (
				<div className="border-t p-4">
					<p className="mb-4 text-muted-foreground text-xs">
						{m.vaults_detail_items_totp_settings_description()}
					</p>
					<div className="grid grid-cols-3 gap-4">
						<div className="space-y-2">
							<Label>
								{m.vaults_detail_items_totp_settings_field_algorithm()}
							</Label>
							<select
								value={algorithm}
								onChange={(e) =>
									onAlgorithmChange(e.target.value as TotpAlgorithm)
								}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							>
								<option value="SHA1">
									{m.vaults_detail_items_totp_settings_option_algorithm_sha1()}
								</option>
								<option value="SHA256">
									{m.vaults_detail_items_totp_settings_option_algorithm_sha256()}
								</option>
								<option value="SHA512">
									{m.vaults_detail_items_totp_settings_option_algorithm_sha512()}
								</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label>
								{m.vaults_detail_items_totp_settings_field_code_length()}
							</Label>
							<select
								value={digits}
								onChange={(e) =>
									onDigitsChange(Number(e.target.value) as TotpDigits)
								}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							>
								<option value={6}>
									{m.vaults_detail_items_totp_settings_option_digits_6()}
								</option>
								<option value={7}>
									{m.vaults_detail_items_totp_settings_option_digits_7()}
								</option>
								<option value={8}>
									{m.vaults_detail_items_totp_settings_option_digits_8()}
								</option>
							</select>
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
