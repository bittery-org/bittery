import { cn } from "@bittery/ui";

export function getScoreTextClassName(score: number): string {
	if (score >= 80) {
		return "text-success";
	}

	if (score >= 50) {
		return "text-warning";
	}

	return "text-destructive";
}

export function ScoreRing({
	score,
	gaugeLabel,
}: {
	score: number;
	gaugeLabel: string;
}) {
	const normalizedScore = Math.max(0, Math.min(100, score));
	const radius = 42;
	const circumference = 2 * Math.PI * radius;
	const strokeOffset = circumference - (normalizedScore / 100) * circumference;

	return (
		<div className="relative size-27">
			<svg
				viewBox="0 0 108 108"
				className="h-full w-full -rotate-90"
				aria-hidden="true"
			>
				<circle
					cx="54"
					cy="54"
					r="42"
					stroke="currentColor"
					strokeWidth="9"
					className="text-border"
					fill="none"
				/>
				<circle
					cx="54"
					cy="54"
					r="42"
					stroke="currentColor"
					strokeWidth="9"
					strokeLinecap="round"
					fill="none"
					strokeDasharray={circumference}
					strokeDashoffset={strokeOffset}
					className={cn(
						getScoreTextClassName(normalizedScore),
						"transition-[stroke-dashoffset]",
						"duration-700",
						"ease-out",
					)}
				/>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center text-center">
				<span
					className={cn(
						"font-semibold text-xl tabular-nums leading-none",
						getScoreTextClassName(normalizedScore),
					)}
				>
					{normalizedScore}
				</span>
				<span className="mt-0.5 text-[9px] text-muted-foreground tracking-[0.24em]">
					{gaugeLabel}
				</span>
			</div>
		</div>
	);
}
