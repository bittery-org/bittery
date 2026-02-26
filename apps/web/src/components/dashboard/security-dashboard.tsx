import type {
	PasswordIssue,
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
	label: string;
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
	vaults: Array<{ id: string; name: string }> = [],
): string {
	return vaults.find((v) => v.id === vaultId)?.name || "Unknown Vault";
}

function getScorePalette(score: number) {
	if (score >= 85) {
		return {
			label: "FORTIFIED",
			description:
				"Your overall password posture is strong. Keep rotating aging credentials and preserve this baseline.",
			textClassName: "text-emerald-300",
			ringClassName: "from-emerald-400 via-teal-300 to-cyan-300",
		};
	}

	if (score >= 70) {
		return {
			label: "STABLE",
			description:
				"Coverage is healthy, but there are weak points worth hardening before they become meaningful risk.",
			textClassName: "text-lime-300",
			ringClassName: "from-lime-400 via-emerald-300 to-cyan-300",
		};
	}

	if (score >= 50) {
		return {
			label: "EXPOSED",
			description:
				"Risk signals are building up. Prioritize weak and reused passwords to improve resilience quickly.",
			textClassName: "text-amber-300",
			ringClassName: "from-amber-400 via-orange-300 to-yellow-300",
		};
	}

	if (score >= 30) {
		return {
			label: "AT RISK",
			description:
				"Multiple vulnerabilities are active. Resolve urgent issues now to reduce account takeover exposure.",
			textClassName: "text-orange-300",
			ringClassName: "from-orange-400 via-rose-300 to-red-300",
		};
	}

	return {
		label: "CRITICAL",
		description:
			"Your vault has severe password risk. Immediate remediation is recommended across high-value accounts.",
		textClassName: "text-rose-300",
		ringClassName: "from-rose-400 via-red-400 to-orange-400",
	};
}

function getDistribution(report: SecurityReport): DistributionBucket[] {
	const total = Math.max(report.totalPasswords, 0);
	if (total === 0) {
		return [
			{
				label: "Healthy",
				count: 0,
				percentage: 0,
				barClassName: "bg-emerald-400",
				dotClassName: "bg-emerald-400",
			},
			{
				label: "Aging",
				count: 0,
				percentage: 0,
				barClassName: "bg-amber-400",
				dotClassName: "bg-amber-400",
			},
			{
				label: "Reused",
				count: 0,
				percentage: 0,
				barClassName: "bg-orange-400",
				dotClassName: "bg-orange-400",
			},
			{
				label: "Weak",
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
			label: "Healthy",
			count: healthyCount,
			percentage: (healthyCount / total) * 100,
			barClassName: "bg-emerald-400",
			dotClassName: "bg-emerald-400",
		},
		{
			label: "Aging",
			count: oldCount,
			percentage: (oldCount / total) * 100,
			barClassName: "bg-amber-400",
			dotClassName: "bg-amber-400",
		},
		{
			label: "Reused",
			count: reusedCount,
			percentage: (reusedCount / total) * 100,
			barClassName: "bg-orange-400",
			dotClassName: "bg-orange-400",
		},
		{
			label: "Weak",
			count: weakCount,
			percentage: (weakCount / total) * 100,
			barClassName: "bg-rose-400",
			dotClassName: "bg-rose-400",
		},
	];
}

function ScoreRing({ score }: { score: number }) {
	const normalizedScore = Math.max(0, Math.min(100, score));
	const radius = 66;
	const circumference = 2 * Math.PI * radius;
	const strokeOffset = circumference - (normalizedScore / 100) * circumference;
	const scorePalette = getScorePalette(normalizedScore);

	return (
		<div className="relative h-44 w-44">
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
					SCORE
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
			<CardContent className="relative space-y-8 p-6 md:p-8">
				<div className="flex flex-wrap items-center gap-2">
					<Badge
						variant="outline"
						className="border-emerald-300/40 bg-emerald-300/10 px-2.5 py-0.5 font-medium text-[11px] text-emerald-100 tracking-[0.2em]"
					>
						SENTINEL WATCH
					</Badge>
					<Badge
						variant="outline"
						className="border-cyan-300/35 bg-cyan-300/10 px-2.5 py-0.5 font-medium text-[11px] text-cyan-100 tracking-[0.16em]"
					>
						{scorePalette.label}
					</Badge>
				</div>

				<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
					<div className="space-y-6">
						<div className="space-y-2">
							<h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
								Security posture, live and prioritized
							</h2>
							<p className="max-w-2xl text-slate-300 text-sm leading-relaxed sm:text-base">
								{scorePalette.description}
							</p>
						</div>

						<div className="grid gap-3 sm:grid-cols-3">
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em]">
									Passwords monitored
								</p>
								<p className="mt-2 font-semibold text-3xl leading-none">
									{total}
								</p>
							</div>
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em]">
									At-risk items
								</p>
								<p className="mt-2 font-semibold text-3xl text-rose-200 leading-none">
									{uniqueRiskCount}
								</p>
							</div>
							<div className="rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm">
								<p className="text-[11px] text-slate-300 uppercase tracking-[0.16em]">
									High-priority actions
								</p>
								<p className="mt-2 font-semibold text-3xl text-amber-100 leading-none">
									{highPriorityCount}
								</p>
							</div>
						</div>

						<div className="space-y-3 rounded-xl border border-white/15 bg-white/8 p-4 backdrop-blur-sm">
							<div className="flex items-center justify-between text-[11px] text-slate-300 uppercase tracking-[0.16em]">
								<span>Password health mix</span>
								<span>{total} monitored</span>
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
													title={`${bucket.label}: ${bucket.count}`}
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
												{bucket.label} ({bucket.count})
											</span>
										))}
									</div>
								</>
							) : (
								<p className="text-slate-300 text-sm">
									Add passwords to start your first Sentinel health scan.
								</p>
							)}
						</div>
					</div>

					<div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/15 bg-white/10 p-6 backdrop-blur-sm">
						<ScoreRing score={report.securityScore} />
						<div className="text-center">
							<p className="font-semibold text-base">Sentinel Security Score</p>
							<p className="text-slate-300 text-xs uppercase tracking-[0.16em]">
								{healthCoverage}% healthy coverage
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
		<Card className="relative h-full overflow-hidden border-border/60 bg-card/90 shadow-sm">
			<div
				className={cn(
					"pointer-events-none",
					"absolute",
					"inset-x-0",
					"top-0",
					"h-1",
					"bg-gradient-to-r",
					config.accent,
				)}
			/>
			<CardContent className="flex h-full flex-col p-5">
				<div className="flex items-start justify-between gap-4">
					<div
						className={cn("rounded-xl", "border", "p-2.5", config.iconShell)}
					>
						<Icon
							className={cn("h-5", "w-5", config.iconColor)}
							strokeWidth={1.6}
						/>
					</div>
					{hasIssues && !isLoading ? (
						<Badge variant="outline" className={config.pillClassName}>
							Needs action
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
						>
							Resolved
						</Badge>
					)}
				</div>

				<div className="mt-4">
					{isLoading ? (
						<Skeleton className="h-12 w-20" />
					) : (
						<p className="font-semibold text-5xl leading-none tracking-tight">
							{count}
						</p>
					)}
					<h3 className="mt-3 font-semibold text-base tracking-tight">
						{title}
					</h3>
					<p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
						{description}
					</p>
				</div>

				<div className="mt-5 border-t pt-3">
					{hasIssues && onViewItems ? (
						<button
							type="button"
							onClick={onViewItems}
							className="inline-flex w-full items-center justify-between font-medium text-primary text-sm transition-colors hover:text-primary/80"
						>
							Review items
							<ArrowRight className="h-4 w-4" />
						</button>
					) : (
						<span className="inline-flex w-full items-center justify-between text-muted-foreground text-sm">
							No active issues
							<CheckCircle className="h-4 w-4 text-emerald-500" />
						</span>
					)}
				</div>
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
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			<IssueCard
				count={report.weakPasswords.length}
				title="Weak passwords"
				description="Easy-to-crack credentials are your most urgent exposure and should be replaced first."
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
				title="Reused passwords"
				description="Credential reuse multiplies blast radius. Split shared passwords into unique logins."
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
				title="Aging passwords"
				description="Long-lived passwords become brittle over time. Rotate these to stay ahead of breaches."
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
	const item = issue.item;
	const vaultName = getVaultName(item.vaultId, vaults);

	return (
		<Link
			to="/vaults/$vaultId"
			params={{ vaultId: item.vaultId }}
			className="group block"
		>
			<div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/50 p-3 transition-all hover:border-primary/45 hover:bg-muted/40">
				<Favicon
					url={item.url}
					title={item.title}
					category={item.category}
					size="sm"
				/>
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
							<span>Used in {issue.reusedCount} items</span>
						) : null}
						{issue.issueType === "old" && issue.daysSinceUpdate ? (
							<span>{issue.daysSinceUpdate} days old</span>
						) : null}
						{issue.analysis?.crackTime ? (
							<span>Crack time: {issue.analysis.crackTime}</span>
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
	const priorityConfig = {
		high: {
			icon: AlertCircle,
			iconClassName: "text-rose-600",
			label: "High Priority",
			cardClassName: "border-rose-500/25 bg-rose-500/6",
			pillClassName: "border-rose-500/30 bg-rose-500/10 text-rose-600",
		},
		medium: {
			icon: AlertTriangle,
			iconClassName: "text-amber-600",
			label: "Medium",
			cardClassName: "border-amber-500/25 bg-amber-500/6",
			pillClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700",
		},
		low: {
			icon: CheckCircle,
			iconClassName: "text-emerald-600",
			label: "Low",
			cardClassName: "border-emerald-500/25 bg-emerald-500/6",
			pillClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
		},
	} as const;

	return (
		<Card className="border-border/60">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<div className="rounded-lg border border-primary/20 bg-primary/10 p-2">
						<ShieldCheck className="h-5 w-5 text-primary" />
					</div>
					Sentinel briefing
				</CardTitle>
				<CardDescription>
					Prioritized guidance generated from your current password risk
					profile.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{report.recommendations.length === 0 ? (
					<div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
						<p className="font-medium text-emerald-700 text-sm dark:text-emerald-400">
							No critical actions right now.
						</p>
						<p className="mt-1 text-muted-foreground text-sm">
							Sentinel is not detecting urgent password risks in your vault.
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{report.recommendations.map((recommendation, index) => {
							const config = priorityConfig[recommendation.priority];
							const Icon = config.icon;

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
												<p className="font-medium text-sm">
													{recommendation.title}
												</p>
												<Badge
													variant="outline"
													className={config.pillClassName}
												>
													{config.label}
												</Badge>
											</div>
											<p className="text-muted-foreground text-sm">
												{recommendation.description}
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
					<CardHeader className="flex flex-row items-start justify-between gap-4">
						<div>
							<CardTitle>Issue drilldown</CardTitle>
							<CardDescription>
								Inspect flagged credentials and jump directly to each affected
								vault.
							</CardDescription>
						</div>
						<button
							type="button"
							onClick={() => setShowDetails(false)}
							className="text-muted-foreground text-sm transition-colors hover:text-foreground"
						>
							Hide panel
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
									Weak
									{report.weakPasswords.length > 0 ? (
										<Badge variant="destructive" className="ml-1">
											{report.weakPasswords.length}
										</Badge>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="reused" className="flex items-center gap-2">
									<Copy className="h-4 w-4" />
									Reused
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
									Aging
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
									emptyMessage="No weak passwords found. Nice work."
									emptyIcon={ShieldCheck}
								/>
							</TabsContent>

							<TabsContent value="reused" className="mt-4">
								<PasswordIssuesList
									issues={report.reusedPasswords}
									vaults={vaults}
									emptyMessage="No reused passwords found. Each login is unique."
									emptyIcon={CheckCircle}
								/>
							</TabsContent>

							<TabsContent value="old" className="mt-4">
								<PasswordIssuesList
									issues={report.oldPasswords}
									vaults={vaults}
									emptyMessage="No aging passwords right now. Your rotation cadence looks good."
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
								<p className="font-medium">Issue drilldown panel is hidden</p>
								<p className="text-muted-foreground text-sm">
									Pick any issue category above to inspect affected credentials.
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowDetails(true)}
								className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 font-medium text-sm transition-colors hover:bg-muted"
							>
								Open drilldown
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
