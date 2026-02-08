import {
	formatSecretForDisplay,
	generateTotp,
	type TotpResult,
} from "@bittery/shared/totp";
import { Button, Card, copyWithToast, Label } from "@bittery/ui";
import { IconCopyOutlineDuo18 } from "@bittery/ui/icons";
import { useCallback, useEffect, useState } from "react";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import { DetailHeader, DetailPasswordField } from "./field-components";
import type { CategoryDetailProps, TotpDisplayData } from "./shared";

export function TotpDetail({
	data,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<TotpDisplayData>) {
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);

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

	const subtitle = [data.totpIssuer, data.totpAccountName]
		.filter(Boolean)
		.join(" - ");

	return (
		<div className="space-y-4">
			<DetailHeader
				icon={<Favicon title={data.title} category="totp" size="lg" />}
				title={data.title}
				subtitle={subtitle}
			/>

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
								className="size-12 -rotate-90"
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
						<IconCopyOutlineDuo18 size={16} />
					</Button>
				</div>
			</Card>

			<div className="space-y-3">
				<DetailPasswordField
					label="Secret Key"
					value={data.totpSecret}
					maskValue={formatSecretForDisplay(data.totpSecret)}
				/>

				<div className="rounded-lg border p-4">
					<h3 className="mb-3 font-semibold text-sm">Settings</h3>
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

				{/* Tags */}
				{onTagsChange && (
					<div className="space-y-2">
						<Label>Tags</Label>
						<TagInput
							tags={data.tags || []}
							availableTags={availableTags}
							onChange={onTagsChange}
							onTagClick={onTagClick}
							disabled={isUpdatingTags}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
