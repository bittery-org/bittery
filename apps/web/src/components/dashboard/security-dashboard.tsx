import type {
	PasswordIssue,
	SecurityReport,
} from "@bittery/shared/password-analysis";
import {
	strengthToLabel,
	strengthToTextColor,
} from "@bittery/shared/password-analysis";
import { Badge, cn, Skeleton } from "@bittery/ui";
import {
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconTriangleWarningOutlineDuo18 as AlertTriangle,
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconClockTimeOutlineDuo18 as Clock,
	IconCopyOutlineDuo18 as Copy,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconCircleWarningOutlineDuo18 as ShieldAlert,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
} from "@bittery/ui/icons";
import { Link } from "@tanstack/react-router";
import { type ComponentType, useMemo, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "../vault/favicon";
import { ScoreRing } from "./score-ring";

interface SecurityDashboardProps {
	report: SecurityReport;
	isLoading: boolean;
	vaults?: Array<{ id: string; name: string }>;
}

type DashboardIcon = ComponentType<{
	className?: string;
	strokeWidth?: number;
}>;

type SectionKey = "weak" | "reused" | "old" | "briefing";

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

function getScoreTier(score: number) {
	if (score >= 85) {
		return "fortified" as const;
	}

	if (score >= 70) {
		return "stable" as const;
	}

	if (score >= 50) {
		return "exposed" as const;
	}

	if (score >= 30) {
		return "at_risk" as const;
	}

	return "critical" as const;
}

/** Buckets every monitored password once, with weak > reused > old precedence. */
function getDistribution(report: SecurityReport): DistributionBucket[] {
	const total = Math.max(report.totalPasswords, 0);

	const weakIds = new Set(report.weakPasswords.map((issue) => issue.item.id));
	const classified = new Set<string>(weakIds);

	let reusedCount = 0;
	for (const issue of report.reusedPasswords) {
		if (!classified.has(issue.item.id)) {
			reusedCount += 1;
			classified.add(issue.item.id);
		}
	}

	let oldCount = 0;
	for (const issue of report.oldPasswords) {
		if (!classified.has(issue.item.id)) {
			oldCount += 1;
			classified.add(issue.item.id);
		}
	}

	const healthyCount = Math.max(total - classified.size, 0);
	const pct = (count: number) => (total > 0 ? (count / total) * 100 : 0);

	return [
		{
			label: "healthy",
			count: healthyCount,
			percentage: pct(healthyCount),
			barClassName: "bg-success",
			dotClassName: "bg-success",
		},
		{
			label: "aging",
			count: oldCount,
			percentage: pct(oldCount),
			barClassName: "bg-success/60",
			dotClassName: "bg-success/60",
		},
		{
			label: "reused",
			count: reusedCount,
			percentage: pct(reusedCount),
			barClassName: "bg-warning",
			dotClassName: "bg-warning",
		},
		{
			label: "weak",
			count: weakIds.size,
			percentage: pct(weakIds.size),
			barClassName: "bg-destructive",
			dotClassName: "bg-destructive",
		},
	];
}

function IssueRow({
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
		m.sentinel_common_unknown_vault(),
		vaults,
	);

	return (
		<Link
			to="/vaults/$vaultId"
			params={{ vaultId: item.vaultId }}
			search={{ itemId: item.id }}
			className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/4"
		>
			<Favicon item={item} size="sm" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium text-sm">{item.title}</span>
					{issue.analysis ? (
						<Badge
							variant="outline"
							className={cn(
								"px-1.5 py-0 text-[10px]",
								strengthToTextColor(issue.analysis.strength),
							)}
						>
							{strengthToLabel(issue.analysis.strength)}
						</Badge>
					) : null}
				</div>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
					<span className="truncate">{vaultName}</span>
					{issue.issueType === "reused" && issue.reusedCount ? (
						<span>
							{m.sentinel_issue_detail_used_in_items({
								count: issue.reusedCount,
							})}
						</span>
					) : null}
					{issue.issueType === "old" && issue.daysSinceUpdate ? (
						<span>
							{m.sentinel_issue_detail_days_old({
								days: issue.daysSinceUpdate,
							})}
						</span>
					) : null}
					{issue.analysis?.crackTime ? (
						<span>
							{m.sentinel_issue_detail_crack_time({
								time: issue.analysis.crackTime,
							})}
						</span>
					) : null}
				</div>
			</div>
			<ExternalLink
				className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
				strokeWidth={1.6}
			/>
		</Link>
	);
}

function IssueSection({
	id,
	icon: Icon,
	iconClassName,
	title,
	description,
	issues,
	vaults,
	emptyMessage,
}: {
	id: string;
	icon: DashboardIcon;
	iconClassName: string;
	title: string;
	description: string;
	issues: PasswordIssue[];
	vaults: Array<{ id: string; name: string }>;
	emptyMessage: string;
}) {
	return (
		<section id={id} className="scroll-mt-14 rounded-lg border bg-card">
			<div className="flex items-start gap-3 border-b p-4">
				<div className="rounded-md border bg-foreground/3 p-2">
					<Icon className={cn("h-4", "w-4", iconClassName)} strokeWidth={1.6} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="font-medium text-sm">{title}</h3>
						{issues.length > 0 ? (
							<span className="rounded-[4px] border bg-foreground/3 px-1.5 text-[10px] text-muted-foreground tabular-nums">
								{issues.length}
							</span>
						) : null}
					</div>
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{description}
					</p>
				</div>
			</div>
			{issues.length > 0 ? (
				<div className="divide-y">
					{issues.map((issue) => (
						<IssueRow
							key={`${issue.item.id}-${issue.issueType}`}
							issue={issue}
							vaults={vaults}
						/>
					))}
				</div>
			) : (
				<div className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
					<CheckCircle className="h-4 w-4 text-success" strokeWidth={1.6} />
					{emptyMessage}
				</div>
			)}
		</section>
	);
}

function BriefingSection({ report }: { report: SecurityReport }) {
	const { m } = useI18n();

	const priorityConfig = {
		high: {
			icon: AlertCircle,
			iconClassName: "text-destructive",
			label: m.sentinel_recommendations_priority_high(),
		},
		medium: {
			icon: AlertTriangle,
			iconClassName: "text-warning",
			label: m.sentinel_recommendations_priority_medium(),
		},
		low: {
			icon: CheckCircle,
			iconClassName: "text-success",
			label: m.sentinel_recommendations_priority_low(),
		},
	} as const;

	const getRecommendationTitle = (key: string, count: number) => {
		switch (key) {
			case "weak_passwords":
				return count === 1
					? m.sentinel_recommendations_item_weak_title_single({ count })
					: m.sentinel_recommendations_item_weak_title_plural({ count });
			case "reused_passwords":
				return count === 1
					? m.sentinel_recommendations_item_reused_title_single({ count })
					: m.sentinel_recommendations_item_reused_title_plural({ count });
			case "old_passwords":
				return count === 1
					? m.sentinel_recommendations_item_old_title_single({ count })
					: m.sentinel_recommendations_item_old_title_plural({ count });
			case "good_practices":
				return m.sentinel_recommendations_item_good_title();
			case "add_passwords":
				return m.sentinel_recommendations_item_add_title();
			default:
				return m.sentinel_recommendations_empty_title();
		}
	};

	return (
		<section
			id="sentinel-section-briefing"
			className="scroll-mt-14 rounded-lg border bg-card"
		>
			<div className="flex items-start gap-3 border-b p-4">
				<div className="rounded-md border bg-foreground/3 p-2">
					<ShieldCheck
						className="h-4 w-4 text-muted-foreground"
						strokeWidth={1.6}
					/>
				</div>
				<div className="min-w-0 flex-1">
					<h3 className="font-medium text-sm">
						{m.sentinel_recommendations_title()}
					</h3>
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{m.sentinel_recommendations_description()}
					</p>
				</div>
			</div>
			{report.recommendations.length === 0 ? (
				<div className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
					<CheckCircle className="h-4 w-4 text-success" strokeWidth={1.6} />
					{m.sentinel_recommendations_empty_description()}
				</div>
			) : (
				<div className="divide-y">
					{report.recommendations.map((recommendation, index) => {
						const config = priorityConfig[recommendation.priority];
						const Icon = config.icon;

						return (
							<div key={index} className="flex items-center gap-3 px-4 py-3">
								<Icon
									className={cn("h-4", "w-4", "shrink-0", config.iconClassName)}
									strokeWidth={1.6}
								/>
								<p className="min-w-0 flex-1 truncate text-sm">
									{getRecommendationTitle(
										recommendation.key,
										recommendation.count ?? 0,
									)}
								</p>
								<Badge
									variant="outline"
									className="shrink-0 text-[10px] text-muted-foreground"
								>
									{config.label}
								</Badge>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

/**
 * Main Security Dashboard component — a "security report" layout: a sticky
 * rail (score, tier, health mix, section nav) beside always-visible sections
 * for weak / reused / aging credentials and the Sentinel briefing.
 */
export function SecurityDashboard({
	report,
	isLoading,
	vaults = [],
}: SecurityDashboardProps) {
	const { m } = useI18n();
	const [activeSection, setActiveSection] = useState<SectionKey>("weak");
	const distribution = useMemo(() => getDistribution(report), [report]);

	const uniqueRiskCount = useMemo(() => {
		const riskIds = new Set([
			...report.weakPasswords.map((issue) => issue.item.id),
			...report.reusedPasswords.map((issue) => issue.item.id),
			...report.oldPasswords.map((issue) => issue.item.id),
		]);
		return riskIds.size;
	}, [report]);
	const healthCoverage =
		report.totalPasswords > 0
			? Math.round(
					((report.totalPasswords - uniqueRiskCount) / report.totalPasswords) *
						100,
				)
			: 0;

	const tierLabel = {
		fortified: m.sentinel_score_tier_fortified_label(),
		stable: m.sentinel_score_tier_stable_label(),
		exposed: m.sentinel_score_tier_exposed_label(),
		at_risk: m.sentinel_score_tier_at_risk_label(),
		critical: m.sentinel_score_tier_critical_label(),
	}[getScoreTier(report.securityScore)];
	const distributionLabels = {
		healthy: m.sentinel_distribution_healthy(),
		aging: m.sentinel_distribution_aging(),
		reused: m.sentinel_distribution_reused(),
		weak: m.sentinel_distribution_weak(),
	} as const;

	const sections: Array<{
		key: SectionKey;
		id: string;
		label: string;
		count: number | null;
	}> = [
		{
			key: "weak",
			id: "sentinel-section-weak",
			label: m.sentinel_issue_weak_title(),
			count: report.weakPasswords.length,
		},
		{
			key: "reused",
			id: "sentinel-section-reused",
			label: m.sentinel_issue_reused_title(),
			count: report.reusedPasswords.length,
		},
		{
			key: "old",
			id: "sentinel-section-old",
			label: m.sentinel_issue_old_title(),
			count: report.oldPasswords.length,
		},
		{
			key: "briefing",
			id: "sentinel-section-briefing",
			label: m.sentinel_recommendations_title(),
			count: null,
		},
	];

	if (isLoading) {
		return (
			<div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
				<Skeleton className="h-96 w-full rounded-lg" />
				<div className="space-y-4">
					<Skeleton className="h-48 w-full rounded-lg" />
					<Skeleton className="h-48 w-full rounded-lg" />
					<Skeleton className="h-48 w-full rounded-lg" />
				</div>
			</div>
		);
	}

	return (
		<div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start">
			<aside className="rounded-lg border bg-card lg:sticky lg:top-0">
				<div className="flex flex-col items-center gap-2 border-b p-4">
					<ScoreRing
						score={report.securityScore}
						gaugeLabel={m.sentinel_score_gauge_label()}
					/>
					<Badge
						variant="outline"
						className="border-info/30 bg-info/10 px-2.5 py-0.5 font-medium text-[11px] text-info tracking-[0.16em]"
					>
						{tierLabel}
					</Badge>
					<p className="text-muted-foreground text-xs">
						{m.sentinel_overview_score_coverage({ percent: healthCoverage })}
					</p>
				</div>

				<div className="space-y-2.5 border-b p-4">
					<div className="flex items-center justify-between font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
						<span>{m.sentinel_overview_health_mix_title()}</span>
						<span className="normal-case tabular-nums tracking-normal">
							{m.sentinel_overview_health_mix_monitored({
								count: report.totalPasswords,
							})}
						</span>
					</div>
					{report.totalPasswords > 0 ? (
						distribution.map((bucket) => (
							<div key={bucket.label} className="space-y-1">
								<div className="flex items-center justify-between text-xs">
									<span className="inline-flex items-center gap-1.5 text-muted-foreground">
										<span
											aria-hidden
											className={cn(
												"h-2",
												"w-2",
												"rounded-full",
												bucket.dotClassName,
											)}
										/>
										{distributionLabels[bucket.label]}
									</span>
									<span className="tabular-nums">{bucket.count}</span>
								</div>
								<div className="h-1 w-full overflow-hidden rounded-full bg-foreground/8">
									<div
										className={cn(
											"h-full rounded-full transition-all duration-700",
											bucket.barClassName,
										)}
										style={{ width: `${bucket.percentage}%` }}
									/>
								</div>
							</div>
						))
					) : (
						<p className="text-muted-foreground text-sm">
							{m.sentinel_overview_health_mix_empty()}
						</p>
					)}
				</div>

				<nav className="space-y-0.5 p-2">
					{sections.map((section) => {
						const active = activeSection === section.key;

						return (
							<button
								key={section.key}
								type="button"
								onClick={() => {
									setActiveSection(section.key);
									document
										.getElementById(section.id)
										?.scrollIntoView({ behavior: "smooth", block: "start" });
								}}
								className={cn(
									"relative flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm transition-colors",
									active
										? "bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
										: "text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
							>
								{active ? (
									<span
										aria-hidden
										className="absolute top-[6px] bottom-[6px] -left-0.5 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
									/>
								) : null}
								<span className="min-w-0 flex-1 truncate text-left">
									{section.label}
								</span>
								{section.count !== null && section.count > 0 ? (
									<span className="rounded-[4px] border bg-foreground/3 px-1.5 text-[10px] text-muted-foreground tabular-nums">
										{section.count}
									</span>
								) : null}
							</button>
						);
					})}
				</nav>
			</aside>

			<div className="min-w-0 space-y-4">
				<IssueSection
					id="sentinel-section-weak"
					icon={ShieldAlert}
					iconClassName="text-destructive"
					title={m.sentinel_issue_weak_title()}
					description={m.sentinel_issue_weak_description()}
					issues={report.weakPasswords}
					vaults={vaults}
					emptyMessage={m.sentinel_drilldown_empty_weak()}
				/>
				<IssueSection
					id="sentinel-section-reused"
					icon={Copy}
					iconClassName="text-warning"
					title={m.sentinel_issue_reused_title()}
					description={m.sentinel_issue_reused_description()}
					issues={report.reusedPasswords}
					vaults={vaults}
					emptyMessage={m.sentinel_drilldown_empty_reused()}
				/>
				<IssueSection
					id="sentinel-section-old"
					icon={Clock}
					iconClassName="text-info"
					title={m.sentinel_issue_old_title()}
					description={m.sentinel_issue_old_description()}
					issues={report.oldPasswords}
					vaults={vaults}
					emptyMessage={m.sentinel_drilldown_empty_old()}
				/>
				<BriefingSection report={report} />
			</div>
		</div>
	);
}
