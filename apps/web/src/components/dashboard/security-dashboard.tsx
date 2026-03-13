import type {
	PasswordIssue,
	SecurityRecommendation,
	SecurityReport,
} from "@bittery/shared/password-analysis";
import {
	strengthToLabel,
	strengthToTextColor,
} from "@bittery/shared/password-analysis";
import {
	Badge,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	cn,
	ScrollArea,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import {
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconTriangleWarningOutlineDuo18 as AlertTriangle,
	IconVShapedArrowRightOutlineDuo18 as ArrowRight,
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconClockTimeOutlineDuo18 as Clock,
	IconCopyOutlineDuo18 as Copy,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconArrowsLeftRightTrailOutlineDuo18 as RefreshCw,
	IconCircleWarningOutlineDuo18 as ShieldAlert,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
} from "@bittery/ui/icons";
import { Link } from "@tanstack/react-router";
import { type ComponentType, useMemo, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "../vault/favicon";

interface SecurityDashboardProps {
	report: SecurityReport;
	isLoading: boolean;
	vaults?: Array<{ id: string; name: string }>;
}

type DashboardIcon = ComponentType<{
	className?: string;
	strokeWidth?: number;
}>;

interface DistributionBucket {
	label: "healthy" | "aging" | "reused" | "weak";
	count: number;
	percentage: number;
	barClassName: string;
	dotClassName: string;
}

/**
 * Get the vault name for an item
 */
function getVaultName(
	vaultId: string,
	unknownVaultName: string,
	vaults: Array<{ id: string; name: string }> = [],
): string {
	return vaults.find((v) => v.id === vaultId)?.name || unknownVaultName;
}

function getScorePalette(score: number) {
	if (score >= 85) {
		return {
			tier: "fortified" as const,
			textClassName: "text-emerald-300",
			ringClassName: "from-emerald-400 via-teal-300 to-cyan-300",
		};
	}

	if (score >= 70) {
		return {
			tier: "stable" as const,
			textClassName: "text-lime-300",
			ringClassName: "from-lime-400 via-emerald-300 to-cyan-300",
		};
	}

	if (score >= 50) {
		return {
			tier: "exposed" as const,
			textClassName: "text-amber-300",
			ringClassName: "from-amber-400 via-orange-300 to-yellow-300",
		};
	}

	if (score >= 30) {
		return {
			tier: "at_risk" as const,
			textClassName: "text-orange-300",
			ringClassName: "from-orange-400 via-rose-300 to-red-300",
		};
	}

	return {
		tier: "critical" as const,
		textClassName: "text-rose-300",
		ringClassName: "from-rose-400 via-red-400 to-orange-400",
	};
}

function getDistribution(report: SecurityReport): DistributionBucket[] {
	const total = Math.max(report.totalPasswords, 0);
	if (total === 0) {
		return [
			{
				label: "healthy",
				count: 0,
				percentage: 0,
				barClassName: "bg-emerald-400",
				dotClassName: "bg-emerald-400",
			},
			{
				label: "aging",
				count: 0,
				percentage: 0,
				barClassName: "bg-amber-400",
				dotClassName: "bg-amber-400",
			},
			{
				label: "reused",
				count: 0,
				percentage: 0,
				barClassName: "bg-orange-400",
				dotClassName: "bg-orange-400",
			},
			{
				label: "weak",
				count: 0,
				percentage: 0,
				barClassName: "bg-rose-400",
				dotClassName: "bg-rose-400",
			},
		];
	}

	const weakIds = new Set(report.weakPasswords.map((issue) => issue.item.id));
	const reusedIds = new Set(
		report.reusedPasswords.map((issue) => issue.item.id),
	);
	const oldIds = new Set(report.oldPasswords.map((issue) => issue.item.id));

	const classifiedIds = new Set<string>();
	const weakCount = weakIds.size;
	for (const id of weakIds) {
		classifiedIds.add(id);
	}

	let reusedCount = 0;
	for (const id of reusedIds) {
		if (!classifiedIds.has(id)) {
			reusedCount += 1;
			classifiedIds.add(id);
		}
	}

	let oldCount = 0;
	for (const id of oldIds) {
		if (!classifiedIds.has(id)) {
			oldCount += 1;
			classifiedIds.add(id);
		}
	}

	const healthyCount = Math.max(total - classifiedIds.size, 0);

	return [
		{
			label: "healthy",
			count: healthyCount,
			percentage: (healthyCount / total) * 100,
			barClassName: "bg-emerald-400",
			dotClassName: "bg-emerald-400",
		},
		{
			label: "aging",
			count: oldCount,
			percentage: (oldCount / total) * 100,
			barClassName: "bg-amber-400",
			dotClassName: "bg-amber-400",
		},
		{
			label: "reused",
			count: reusedCount,
			percentage: (reusedCount / total) * 100,
			barClassName: "bg-orange-400",
			dotClassName: "bg-orange-400",
		},
		{
			label: "weak",
			count: weakCount,
			percentage: (weakCount / total) * 100,
			barClassName: "bg-rose-400",
			dotClassName: "bg-rose-400",
		},
	];
}

function ScoreRing({
	score,
	gaugeLabel,
}: {
	score: number;
	gaugeLabel: string;
}) {
	const normalizedScore = Math.max(0, Math.min(100, score));
	const radius = 66;
	const circumference = 2 * Math.PI * radius;
	const strokeOffset = circumference - (normalizedScore / 100) * circumference;
	const scorePalette = getScorePalette(normalizedScore);

	return (
		<div className="relative h-36 w-36 sm:h-44 sm:w-44">
			<svg
				viewBox="0 0 176 176"
				className="h-full w-full -rotate-90"
				aria-hidden="true"
			>
				<circle
					cx="88"
					cy="88"
					r="66"
					stroke="currentColor"
					strokeWidth="14"
					className="text-white/15"
					fill="none"
				/>
				<circle
					cx="88"
					cy="88"
					r="66"
					stroke="currentColor"
					strokeWidth="14"
					strokeLinecap="round"
					fill="none"
					strokeDasharray={circumference}
					strokeDashoffset={strokeOffset}
					className={cn(
						scorePalette.textClassName,
						"transition-[stroke-dashoffset]",
						"duration-700",
						"ease-out",
					)}
				/>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center text-center">
				<span
					className={cn(
						"font-semibold",
						"text-5xl",
						"leading-none",
						scorePalette.textClassName,
					)}
				>
					{normalizedScore}
				</span>
				<span className="mt-1 text-[11px] text-white/60 tracking-[0.28em]">
					{gaugeLabel}
				</span>
			</div>
			<div
				className={cn(
					"pointer-events-none",
					"absolute",
					"inset-0",
					"-z-10",
					"rounded-full",
					"bg-gradient-to-br",
					"opacity-35",
					"blur-2xl",
					scorePalette.ringClassName,
				)}
			/>
		</div>
	);
}

function SentinelOverview({
	report,
	isLoading,
}: {
	report: SecurityReport;
	isLoading: boolean;
}) {
	const { m } = useI18n();
	const distribution = useMemo(() => getDistribution(report), [report]);
	const total = report.totalPasswords;
	const uniqueRiskCount = useMemo(() => {
		const riskIds = new Set([
			...report.weakPasswords.map((issue) => issue.item.id),
			...report.reusedPasswords.map((issue) => issue.item.id),
			...report.oldPasswords.map((issue) => issue.item.id),
		]);
		return riskIds.size;
	}, [report]);
	const healthyCount = Math.max(total - uniqueRiskCount, 0);
	const healthCoverage =
		total > 0 ? Math.round((healthyCount / total) * 100) : 0;
	const highPriorityCount = report.recommendations.filter(
		(recommendation) => recommendation.priority === "high",
	).length;
	const scorePalette = getScorePalette(report.securityScore);
	const scoreTierLabel = {
		fortified: m["sentinel.score.tier.fortified.label"](),
		stable: m["sentinel.score.tier.stable.label"](),
		exposed: m["sentinel.score.tier.exposed.label"](),
		at_risk: m["sentinel.score.tier.at_risk.label"](),
		critical: m["sentinel.score.tier.critical.label"](),
	}[scorePalette.tier];
	const scoreTierDescription = {
		fortified: m["sentinel.score.tier.fortified.description"](),
		stable: m["sentinel.score.tier.stable.description"](),
		exposed: m["sentinel.score.tier.exposed.description"](),
		at_risk: m["sentinel.score.tier.at_risk.description"](),
		critical: m["sentinel.score.tier.critical.description"](),
	}[scorePalette.tier];
	const distributionLabels = {
		healthy: m["sentinel.distribution.healthy"](),
		aging: m["sentinel.distribution.aging"](),
		reused: m["sentinel.distribution.reused"](),
		weak: m["sentinel.distribution.weak"](),
	} as const;

	if (isLoading) {
		return (
			<Card className="overflow-hidden border-border/60">
				<CardContent className="space-y-6 p-6 md:p-8">
					<Skeleton className="h-6 w-40" />
					<Skeleton className="h-9 w-80" />
					<div className="grid gap-4 sm:grid-cols-3">
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-20 w-full" />
					</div>
					<Skeleton className="h-32 w-full" />
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="relative overflow-hidden border-slate-900/80 bg-[radial-gradient(circle_at_15%_20%,rgba(16,185,129,0.28),transparent_38%),radial-gradient(circle_at_90%_10%,rgba(34,211,238,0.18),transparent_30%),linear-gradient(130deg,#020617_0%,#0f172a_45%,#022c22_100%)] text-slate-100 shadow-[0_24px_70px_-45px_rgba(16,185,129,0.85)]">
			<div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:28px_28px]" />
			<CardContent className="relative space-y-5 p-5 md:p-8 lg:space-y-8">
				<div className="flex flex-wrap items-center gap-2">
					<Badge
						variant="outline"
						className="border-emerald-300/40 bg-emerald-300/10 px-2.5 py-0.5 font-medium text-[11px] text-emerald-100 tracking-[0.2em]"
					>
						{m["sentinel.overview.badge.watch"]()}
					</Badge>
					<Badge
						variant="outline"
						className="border-cyan-300/35 bg-cyan-300/10 px-2.5 py-0.5 font-medium text-[11px] text-cyan-100 tracking-[0.16em]"
					>
						{scoreTierLabel}
					</Badge>
				</div>

				<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
					<div className="space-y-6">
						<div className="space-y-2">
							<h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
								{m["sentinel.overview.heading"]()}
							</h2>
							<p className="max-w-2xl text-slate-300 text-sm leading-relaxed sm:text-base">
								{scoreTierDescription}
							</p>
						</div>

						<div className="flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:gap-3 lg:grid-cols-1 xl:grid-cols-3">
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm lg:flex lg:items-center lg:justify-between xl:block">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em] lg:text-xs lg:normal-case lg:tracking-normal xl:text-[11px] xl:uppercase xl:tracking-[0.16em]">
									{m["sentinel.overview.stat.passwords_monitored"]()}
								</p>
								<p className="mt-2 font-semibold text-3xl leading-none lg:mt-0 xl:mt-2">
									{total}
								</p>
							</div>
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm lg:flex lg:items-center lg:justify-between xl:block">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em] lg:text-xs lg:normal-case lg:tracking-normal xl:text-[11px] xl:uppercase xl:tracking-[0.16em]">
									{m["sentinel.overview.stat.at_risk_items"]()}
								</p>
								<p className="mt-2 font-semibold text-3xl text-rose-200 leading-none lg:mt-0 xl:mt-2">
									{uniqueRiskCount}
								</p>
							</div>
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm lg:flex lg:items-center lg:justify-between xl:block">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em] lg:text-xs lg:normal-case lg:tracking-normal xl:text-[11px] xl:uppercase xl:tracking-[0.16em]">
									{m["sentinel.overview.stat.high_priority_actions"]()}
								</p>
								<p className="mt-2 font-semibold text-3xl text-amber-100 leading-none lg:mt-0 xl:mt-2">
									{highPriorityCount}
								</p>
							</div>
						</div>

						<div className="space-y-3 rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm">
							<div className="flex items-center justify-between gap-2 text-[11px] text-slate-300 uppercase tracking-[0.12em] sm:tracking-[0.16em]">
								<span className="shrink-0">
									{m["sentinel.overview.health_mix.title"]()}
								</span>
								<span className="truncate text-right">
									{m["sentinel.overview.health_mix.monitored"]({
										count: total,
									})}
								</span>
							</div>

							{total > 0 ? (
								<>
									<div className="flex h-3 w-full overflow-hidden rounded-full bg-white/12">
										{distribution
											.filter((bucket) => bucket.percentage > 0)
											.map((bucket) => (
												<div
													key={bucket.label}
													className={cn(
														"h-full",
														bucket.barClassName,
														"transition-all",
														"duration-700",
													)}
													style={{ width: `${bucket.percentage}%` }}
													title={`${distributionLabels[bucket.label]}: ${bucket.count}`}
												/>
											))}
									</div>
									<div className="flex flex-wrap gap-x-4 gap-y-2 text-slate-200 text-xs">
										{distribution.map((bucket) => (
											<span
												key={bucket.label}
												className="inline-flex items-center gap-1.5"
											>
												<span
													className={cn(
														"h-2",
														"w-2",
														"rounded-full",
														bucket.dotClassName,
													)}
												/>
												{distributionLabels[bucket.label]} ({bucket.count})
											</span>
										))}
									</div>
								</>
							) : (
								<p className="text-slate-300 text-sm">
									{m["sentinel.overview.health_mix.empty"]()}
								</p>
							)}
						</div>
					</div>

					<div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm sm:gap-4 sm:p-6">
						<ScoreRing
							score={report.securityScore}
							gaugeLabel={m["sentinel.score.gauge_label"]()}
						/>
						<div className="text-center">
							<p className="font-semibold text-base">
								{m["sentinel.overview.score.title"]()}
							</p>
							<p className="text-slate-300 text-xs uppercase tracking-[0.16em]">
								{m["sentinel.overview.score.coverage"]({
									percent: healthCoverage,
								})}
							</p>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function IssueCard({
	count,
	title,
	description,
	icon: Icon,
	isLoading,
	tone,
	onViewItems,
}: {
	count: number;
	title: string;
	description: string;
	icon: DashboardIcon;
	isLoading: boolean;
	tone: "weak" | "reused" | "old";
	onViewItems?: () => void;
}) {
	const { m } = useI18n();
	const hasIssues = count > 0;

	const toneConfig = {
		weak: {
			accent: "from-rose-500/70 via-rose-500/30 to-transparent",
			iconShell: "border-rose-500/25 bg-rose-500/10",
			iconColor: "text-rose-500",
			pillClassName: "border-rose-500/30 bg-rose-500/10 text-rose-600",
		},
		reused: {
			accent: "from-orange-500/70 via-orange-500/30 to-transparent",
			iconShell: "border-orange-500/25 bg-orange-500/10",
			iconColor: "text-orange-500",
			pillClassName: "border-orange-500/30 bg-orange-500/10 text-orange-600",
		},
		old: {
			accent: "from-amber-500/70 via-amber-500/30 to-transparent",
			iconShell: "border-amber-500/25 bg-amber-500/10",
			iconColor: "text-amber-600",
			pillClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700",
		},
	} as const;

	const config = toneConfig[tone];

	return (
		<Card className="relative overflow-hidden border-border/60 py-1">
			<CardContent className="p-4">
				<div className="flex items-center gap-3">
					<div className={cn("rounded-lg", "border", "p-2", config.iconShell)}>
						<Icon
							className={cn("h-4", "w-4", config.iconColor)}
							strokeWidth={1.6}
						/>
					</div>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm leading-none">{title}</p>
						<p className="mt-1 text-muted-foreground text-xs">{description}</p>
					</div>
					<div className="shrink-0 text-right">
						{isLoading ? (
							<Skeleton className="h-7 w-10" />
						) : (
							<p
								className={cn(
									"font-semibold text-2xl tabular-nums leading-none",
									hasIssues ? config.iconColor : "text-emerald-500",
								)}
							>
								{count}
							</p>
						)}
					</div>
				</div>
				{!isLoading && (
					<div className="mt-3 border-t pt-3">
						{hasIssues && onViewItems ? (
							<button
								type="button"
								onClick={onViewItems}
								className="inline-flex w-full items-center justify-between text-muted-foreground text-xs transition-colors hover:text-foreground"
							>
								{m["sentinel.issue.action.review_items"]()}
								<ArrowRight className="h-3.5 w-3.5" />
							</button>
						) : (
							<span className="inline-flex w-full items-center justify-between text-muted-foreground text-xs">
								{m["sentinel.issue.action.no_active_issues"]()}
								<CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
							</span>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function IssueCardsSection({
	report,
	isLoading,
	onViewIssues,
}: {
	report: SecurityReport;
	isLoading: boolean;
	onViewIssues: (tab: "weak" | "reused" | "old") => void;
}) {
	const { m } = useI18n();

	return (
		<div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
			<IssueCard
				count={report.weakPasswords.length}
				title={m["sentinel.issue.weak.title"]()}
				description={m["sentinel.issue.weak.description"]()}
				icon={ShieldAlert}
				isLoading={isLoading}
				tone="weak"
				onViewItems={
					report.weakPasswords.length > 0
						? () => onViewIssues("weak")
						: undefined
				}
			/>
			<IssueCard
				count={report.reusedPasswords.length}
				title={m["sentinel.issue.reused.title"]()}
				description={m["sentinel.issue.reused.description"]()}
				icon={Copy}
				isLoading={isLoading}
				tone="reused"
				onViewItems={
					report.reusedPasswords.length > 0
						? () => onViewIssues("reused")
						: undefined
				}
			/>
			<IssueCard
				count={report.oldPasswords.length}
				title={m["sentinel.issue.old.title"]()}
				description={m["sentinel.issue.old.description"]()}
				icon={Clock}
				isLoading={isLoading}
				tone="old"
				onViewItems={
					report.oldPasswords.length > 0 ? () => onViewIssues("old") : undefined
				}
			/>
		</div>
	);
}

function PasswordIssueItem({
	issue,
	vaults,
}: {
	issue: PasswordIssue;
	vaults: Array<{ id: string; name: string }>;
}) {
	const { m } = useI18n();
	const item = issue.item;
	const vaultName = getVaultName(
		item.vaultId,
		m["sentinel.common.unknown_vault"](),
		vaults,
	);

	return (
		<Link
			to="/vaults/$vaultId"
			params={{ vaultId: item.vaultId }}
			className="group block"
		>
			<div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/50 p-3 transition-all hover:border-primary/45 hover:bg-muted/40">
				<Favicon item={item} size="sm" />
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium">{item.title}</span>
						{issue.analysis && (
							<Badge
								variant="outline"
								className={cn(
									"text-[11px]",
									strengthToTextColor(issue.analysis.strength),
								)}
							>
								{strengthToLabel(issue.analysis.strength)}
							</Badge>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
						<span className="truncate">{vaultName}</span>
						{issue.issueType === "reused" && issue.reusedCount ? (
							<span>
								{m["sentinel.issue.detail.used_in_items"]({
									count: issue.reusedCount,
								})}
							</span>
						) : null}
						{issue.issueType === "old" && issue.daysSinceUpdate ? (
							<span>
								{m["sentinel.issue.detail.days_old"]({
									days: issue.daysSinceUpdate,
								})}
							</span>
						) : null}
						{issue.analysis?.crackTime ? (
							<span>
								{m["sentinel.issue.detail.crack_time"]({
									time: issue.analysis.crackTime,
								})}
							</span>
						) : null}
					</div>
				</div>
				<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
			</div>
		</Link>
	);
}

function PasswordIssuesList({
	issues,
	vaults,
	emptyMessage,
	emptyIcon: EmptyIcon,
}: {
	issues: PasswordIssue[];
	vaults: Array<{ id: string; name: string }>;
	emptyMessage: string;
	emptyIcon: DashboardIcon;
}) {
	if (issues.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/5 py-10 text-center">
				<EmptyIcon
					className="mb-2 h-12 w-12 text-emerald-500"
					strokeWidth={1.6}
				/>
				<p className="text-muted-foreground text-sm">{emptyMessage}</p>
			</div>
		);
	}

	return (
		<ScrollArea className="h-[320px] pr-4">
			<div className="space-y-2.5">
				{issues.map((issue) => (
					<PasswordIssueItem
						key={`${issue.item.id}-${issue.issueType}`}
						issue={issue}
						vaults={vaults}
					/>
				))}
			</div>
		</ScrollArea>
	);
}

function SentinelRecommendations({ report }: { report: SecurityReport }) {
	const { m } = useI18n();

	const priorityConfig = {
		high: {
			icon: AlertCircle,
			iconClassName: "text-rose-600",
			label: m["sentinel.recommendations.priority.high"](),
			cardClassName: "border-rose-500/25 bg-rose-500/6",
			pillClassName: "border-rose-500/30 bg-rose-500/10 text-rose-600",
		},
		medium: {
			icon: AlertTriangle,
			iconClassName: "text-amber-600",
			label: m["sentinel.recommendations.priority.medium"](),
			cardClassName: "border-amber-500/25 bg-amber-500/6",
			pillClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700",
		},
		low: {
			icon: CheckCircle,
			iconClassName: "text-emerald-600",
			label: m["sentinel.recommendations.priority.low"](),
			cardClassName: "border-emerald-500/25 bg-emerald-500/6",
			pillClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
		},
	} as const;

	const getRecommendationCopy = (recommendation: SecurityRecommendation) => {
		switch (recommendation.key) {
			case "weak_passwords":
				return {
					title:
						(recommendation.count ?? 0) === 1
							? m["sentinel.recommendations.item.weak.title.single"]({
									count: recommendation.count ?? 0,
								})
							: m["sentinel.recommendations.item.weak.title.plural"]({
									count: recommendation.count ?? 0,
								}),
					description: m["sentinel.recommendations.item.weak.description"](),
				};
			case "reused_passwords":
				return {
					title:
						(recommendation.count ?? 0) === 1
							? m["sentinel.recommendations.item.reused.title.single"]({
									count: recommendation.count ?? 0,
								})
							: m["sentinel.recommendations.item.reused.title.plural"]({
									count: recommendation.count ?? 0,
								}),
					description: m["sentinel.recommendations.item.reused.description"](),
				};
			case "old_passwords":
				return {
					title:
						(recommendation.count ?? 0) === 1
							? m["sentinel.recommendations.item.old.title.single"]({
									count: recommendation.count ?? 0,
								})
							: m["sentinel.recommendations.item.old.title.plural"]({
									count: recommendation.count ?? 0,
								}),
					description: m["sentinel.recommendations.item.old.description"](),
				};
			case "good_practices":
				return {
					title: m["sentinel.recommendations.item.good.title"](),
					description: m["sentinel.recommendations.item.good.description"](),
				};
			case "add_passwords":
				return {
					title: m["sentinel.recommendations.item.add.title"](),
					description: m["sentinel.recommendations.item.add.description"](),
				};
			default:
				return {
					title: m["sentinel.recommendations.empty.title"](),
					description: m["sentinel.recommendations.empty.description"](),
				};
		}
	};

	return (
		<Card className="border-border/60">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<div className="rounded-lg border border-primary/20 bg-primary/10 p-2">
						<ShieldCheck className="h-5 w-5 text-primary" />
					</div>
					{m["sentinel.recommendations.title"]()}
				</CardTitle>
				<CardDescription>
					{m["sentinel.recommendations.description"]()}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{report.recommendations.length === 0 ? (
					<div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
						<p className="font-medium text-emerald-700 text-sm dark:text-emerald-400">
							{m["sentinel.recommendations.empty.title"]()}
						</p>
						<p className="mt-1 text-muted-foreground text-sm">
							{m["sentinel.recommendations.empty.description"]()}
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{report.recommendations.map((recommendation, index) => {
							const config = priorityConfig[recommendation.priority];
							const Icon = config.icon;
							const copy = getRecommendationCopy(recommendation);

							return (
								<div
									key={index}
									className={cn(
										"rounded-xl",
										"border",
										"p-4",
										config.cardClassName,
									)}
								>
									<div className="flex items-start gap-3">
										<div className="rounded-lg bg-background/75 p-2">
											<Icon
												className={cn("h-4", "w-4", config.iconClassName)}
											/>
										</div>
										<div className="min-w-0 flex-1 space-y-1">
											<div className="flex items-center gap-2">
												<p className="font-medium text-sm">{copy.title}</p>
												<Badge
													variant="outline"
													className={config.pillClassName}
												>
													{config.label}
												</Badge>
											</div>
											<p className="text-muted-foreground text-sm">
												{copy.description}
											</p>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * Main Security Dashboard component
 */
export function SecurityDashboard({
	report,
	isLoading,
	vaults = [],
}: SecurityDashboardProps) {
	const { m } = useI18n();
	const [activeTab, setActiveTab] = useState<"weak" | "reused" | "old">("weak");
	const [showDetails, setShowDetails] = useState(false);

	const handleViewIssues = (tab: "weak" | "reused" | "old") => {
		setActiveTab(tab);
		setShowDetails(true);
	};

	return (
		<div className="space-y-6">
			<SentinelOverview report={report} isLoading={isLoading} />

			<IssueCardsSection
				report={report}
				isLoading={isLoading}
				onViewIssues={handleViewIssues}
			/>

			{showDetails && !isLoading ? (
				<Card className="border-border/60">
					<CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
						<div>
							<CardTitle>{m["sentinel.drilldown.title"]()}</CardTitle>
							<CardDescription>
								{m["sentinel.drilldown.description"]()}
							</CardDescription>
						</div>
						<button
							type="button"
							onClick={() => setShowDetails(false)}
							className="text-muted-foreground text-sm transition-colors hover:text-foreground"
						>
							{m["sentinel.drilldown.hide_panel"]()}
						</button>
					</CardHeader>
					<CardContent>
						<Tabs
							value={activeTab}
							onValueChange={(value) => setActiveTab(value as typeof activeTab)}
							className="w-full"
						>
							<TabsList className="grid w-full grid-cols-3 bg-muted/60 p-1">
								<TabsTrigger value="weak" className="flex items-center gap-2">
									<ShieldAlert className="h-4 w-4" />
									{m["sentinel.drilldown.tab.weak"]()}
									{report.weakPasswords.length > 0 ? (
										<Badge variant="destructive" className="ml-1">
											{report.weakPasswords.length}
										</Badge>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="reused" className="flex items-center gap-2">
									<Copy className="h-4 w-4" />
									{m["sentinel.drilldown.tab.reused"]()}
									{report.reusedPasswords.length > 0 ? (
										<Badge
											variant="secondary"
											className="ml-1 bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300"
										>
											{report.reusedPasswords.length}
										</Badge>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="old" className="flex items-center gap-2">
									<Clock className="h-4 w-4" />
									{m["sentinel.drilldown.tab.old"]()}
									{report.oldPasswords.length > 0 ? (
										<Badge
											variant="secondary"
											className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
										>
											{report.oldPasswords.length}
										</Badge>
									) : null}
								</TabsTrigger>
							</TabsList>

							<TabsContent value="weak" className="mt-4">
								<PasswordIssuesList
									issues={report.weakPasswords}
									vaults={vaults}
									emptyMessage={m["sentinel.drilldown.empty.weak"]()}
									emptyIcon={ShieldCheck}
								/>
							</TabsContent>

							<TabsContent value="reused" className="mt-4">
								<PasswordIssuesList
									issues={report.reusedPasswords}
									vaults={vaults}
									emptyMessage={m["sentinel.drilldown.empty.reused"]()}
									emptyIcon={CheckCircle}
								/>
							</TabsContent>

							<TabsContent value="old" className="mt-4">
								<PasswordIssuesList
									issues={report.oldPasswords}
									vaults={vaults}
									emptyMessage={m["sentinel.drilldown.empty.old"]()}
									emptyIcon={RefreshCw}
								/>
							</TabsContent>
						</Tabs>
					</CardContent>
				</Card>
			) : (
				!isLoading && (
					<Card className="border-border/60">
						<CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
							<div>
								<p className="font-medium">
									{m["sentinel.drilldown.hidden.title"]()}
								</p>
								<p className="text-muted-foreground text-sm">
									{m["sentinel.drilldown.hidden.description"]()}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowDetails(true)}
								className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 font-medium text-sm transition-colors hover:bg-muted"
							>
								{m["sentinel.drilldown.open"]()}
								<ArrowRight className="h-4 w-4" />
							</button>
						</CardContent>
					</Card>
				)
			)}

			{!isLoading ? <SentinelRecommendations report={report} /> : null}
		</div>
	);
}
