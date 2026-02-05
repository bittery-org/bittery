import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { Input, Label } from "@bittery/ui";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import { useState } from "react";

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
	const [showAdvanced, setShowAdvanced] = useState(defaultExpanded);

	return (
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
						Most services use the default settings. Only change these if your
						service specifies different values.
					</p>
					<div className="grid grid-cols-3 gap-4">
						<div className="space-y-2">
							<Label>Algorithm</Label>
							<select
								value={algorithm}
								onChange={(e) =>
									onAlgorithmChange(e.target.value as TotpAlgorithm)
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
								value={digits}
								onChange={(e) =>
									onDigitsChange(Number(e.target.value) as TotpDigits)
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
