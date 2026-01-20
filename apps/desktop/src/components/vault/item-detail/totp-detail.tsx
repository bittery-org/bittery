import {
	formatSecretForDisplay,
	generateTotp,
	type TotpResult,
} from "@bittery/shared/totp";
import { Button, Card, copyWithToast, Input, Label } from "@bittery/ui";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Favicon } from "../favicon";
import {
	type CategoryDetailProps,
	handleCopy,
	type TotpDisplayData,
} from "./shared";

export function TotpDetail({
	data,
	onEdit,
	onDelete,
}: CategoryDetailProps<TotpDisplayData>) {
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);
	const [showSecret, setShowSecret] = useState(false);

	const generateCode = useCallback(async () => {
		try {
			const result = await generateTotp({
				secret: data.totpSecret,
				algorithm: data.totpAlgorithm || "SHA1",
				digits: data.totpDigits || 6,
				period: data.totpPeriod || 30,
			});
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
		}
	}, [data.totpSecret, data.totpAlgorithm, data.totpDigits, data.totpPeriod]);

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
	const circumference = 2 * Math.PI * 18;
	const strokeDashoffset = circumference - (progress / 100) * circumference;

	const getProgressColor = () => {
		if (!totpResult) return "stroke-muted";
		if (totpResult.remainingSeconds <= 5) return "stroke-destructive";
		if (totpResult.remainingSeconds <= 10) return "stroke-yellow-500";
		return "stroke-primary";
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon title={data.title} category="totp" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
					</h2>
					{(data.totpIssuer || data.totpAccountName) && (
						<p className="mt-1 truncate text-muted-foreground text-sm">
							{data.totpIssuer}
							{data.totpIssuer && data.totpAccountName && " - "}
							{data.totpAccountName}
						</p>
					)}
				</div>
			</div>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						Edit
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						Delete
					</Button>
				)}
			</div>

			<Card>
				<div className="flex items-center justify-between p-6">
					<button
						type="button"
						onClick={handleCopyCode}
						className="group flex cursor-pointer items-center gap-4 rounded-lg transition-colors hover:bg-muted/50"
						title="Click to copy"
					>
						<div className="relative flex size-12 items-center justify-center">
							<svg
								className="-rotate-90 size-12"
								viewBox="0 0 40 40"
								aria-hidden="true"
							>
								<circle
									cx="20"
									cy="20"
									r="18"
									fill="none"
									stroke="currentColor"
									strokeWidth="3"
									className="text-muted/30"
								/>
								<circle
									cx="20"
									cy="20"
									r="18"
									fill="none"
									strokeWidth="3"
									strokeLinecap="round"
									className={`transition-all duration-300 ${getProgressColor()}`}
									style={{
										strokeDasharray: circumference,
										strokeDashoffset: strokeDashoffset,
									}}
								/>
							</svg>
							<span className="absolute font-medium font-mono text-sm">
								{totpResult?.remainingSeconds || "--"}
							</span>
						</div>

						<div className="flex flex-col">
							<span className="font-bold font-mono text-4xl tracking-widest">
								{totpResult?.code
									? `${totpResult.code.slice(0, 3)} ${totpResult.code.slice(3)}`
									: "--- ---"}
							</span>
							<span className="text-muted-foreground text-xs">
								Click to copy
							</span>
						</div>
					</button>

					<Button
						size="icon"
						variant="outline"
						onClick={handleCopyCode}
						disabled={!totpResult?.code}
					>
						<Copy size={16} />
					</Button>
				</div>
			</Card>

			<div className="space-y-4">
				<div className="space-y-2">
					<Label>Secret Key</Label>
					<div className="flex gap-2">
						<Input
							type={showSecret ? "text" : "password"}
							value={
								showSecret
									? formatSecretForDisplay(data.totpSecret)
									: "••••••••••••••••"
							}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowSecret(!showSecret)}
						>
							{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(data.totpSecret, "Secret key")}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>

				<div className="rounded-lg border p-4">
					<h3 className="mb-3 font-medium text-sm">Settings</h3>
					<div className="grid grid-cols-3 gap-4 text-sm">
						<div>
							<Label className="text-muted-foreground text-xs">Algorithm</Label>
							<p className="font-medium">{data.totpAlgorithm || "SHA-1"}</p>
						</div>
						<div>
							<Label className="text-muted-foreground text-xs">Digits</Label>
							<p className="font-medium">{data.totpDigits || 6}</p>
						</div>
						<div>
							<Label className="text-muted-foreground text-xs">Period</Label>
							<p className="font-medium">{data.totpPeriod || 30}s</p>
						</div>
					</div>
				</div>

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">Notes</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.notes}
							</div>
						</Card>
					</div>
				)}
			</div>
		</div>
	);
}
