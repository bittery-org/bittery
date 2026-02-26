import { generateTotp, type TotpResult } from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import { Button, cn, copyWithToast } from "@bittery/ui";
import { IconCopyOutlineDuo18 } from "@bittery/ui/icons";
import { useCallback, useEffect, useState } from "react";

interface InlineTotpDisplayProps {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

export function InlineTotpDisplay({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
}: InlineTotpDisplayProps) {
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);

	const generateCode = useCallback(async () => {
		try {
			const result = await generateTotp({
				secret: totpSecret,
				algorithm: totpAlgorithm,
				digits: totpDigits,
				period: totpPeriod,
			});
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

	useEffect(() => {
		generateCode();

		const interval = setInterval(() => {
			generateCode();
		}, 1000);

		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopyCode = () => {
		copyWithToast(totpResult?.code, "Code");
	};

	const progress = totpResult?.progress || 0;
	const circumference = 2 * Math.PI * 14;
	const strokeDashoffset = circumference - (progress / 100) * circumference;

	const getProgressColor = () => {
		if (!totpResult) return "stroke-muted";
		if (totpResult.remainingSeconds <= 5) return "stroke-destructive";
		if (totpResult.remainingSeconds <= 10) return "stroke-yellow-500";
		return "stroke-primary";
	};

	return (
		<div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
			<button
				type="button"
				onClick={handleCopyCode}
				className="group flex cursor-pointer items-center gap-3 rounded-lg transition-colors hover:bg-muted/50"
				title="Click to copy"
			>
				<div className="relative flex size-9 items-center justify-center">
					<svg
						className="size-9 -rotate-90"
						viewBox="0 0 32 32"
						aria-hidden="true"
					>
						<circle
							cx="16"
							cy="16"
							r="14"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							className="text-muted/30"
						/>
						<circle
							cx="16"
							cy="16"
							r="14"
							fill="none"
							strokeWidth="2.5"
							strokeLinecap="round"
							className={cn(
								"transition-all",
								"duration-300",
								getProgressColor(),
							)}
							style={{
								strokeDasharray: circumference,
								strokeDashoffset: strokeDashoffset,
							}}
						/>
					</svg>
					<span className="absolute font-medium font-mono text-xs">
						{totpResult?.remainingSeconds || "--"}
					</span>
				</div>

				<div className="flex flex-col">
					<span className="font-bold font-mono text-2xl tracking-widest">
						{totpResult?.code
							? `${totpResult.code.slice(0, 3)} ${totpResult.code.slice(3)}`
							: "--- ---"}
					</span>
					<span className="text-muted-foreground text-xs">
						One-time password
					</span>
				</div>
			</button>

			<Button
				size="icon"
				variant="outline"
				onClick={handleCopyCode}
				disabled={!totpResult?.code}
			>
				<IconCopyOutlineDuo18 size={16} />
			</Button>
		</div>
	);
}
