import { useItems } from "@bittery/core/hooks";
import { usePasswordSecurity } from "@bittery/core/hooks/use-password-security";
import type { SecurityRecommendation } from "@bittery/shared/password-analysis";
import { Button, cn } from "@bittery/ui";
import {
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconTriangleWarningOutlineDuo18 as AlertTriangle,
	IconVShapedArrowRightOutlineDuo18 as ArrowRight,
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
} from "@bittery/ui/icons";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useMemo } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { ScoreRing } from "./score-ring";

type Messages = ReturnType<typeof useI18n>["m"];

const PRIORITY_ICONS = {
	high: { icon: AlertCircle, className: "text-destructive" },
	medium: { icon: AlertTriangle, className: "text-warning" },
	low: { icon: CheckCircle, className: "text-success" },
} as const;

function getRecommendationTitle(
	recommendation: SecurityRecommendation,
	m: Messages,
): string {
	const count = recommendation.count ?? 0;
	switch (recommendation.key) {
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
	}
}

export function SecurityPostureCard() {
	const { m } = useI18n();
	const { items } = useItems();

	// Defer so zxcvbn analysis doesn't block first paint (same as Sentinel).
	const deferredItems = useDeferredValue(items);
	const report = usePasswordSecurity(deferredItems);

	const atRiskCount = useMemo(() => {
		const ids = new Set<string>();
		for (const issue of [
			...report.weakPasswords,
			...report.reusedPasswords,
			...report.oldPasswords,
		]) {
			ids.add(issue.item.id);
		}
		return ids.size;
	}, [report]);

	const totalMonitored = Math.max(report.totalPasswords, 0);
	const distribution = [
		{
			label: m.sentinel_distribution_healthy(),
			count: Math.max(totalMonitored - atRiskCount, 0),
			className: "bg-success",
		},
		{
			label: m.sentinel_distribution_weak(),
			count: report.weakPasswords.length,
			className: "bg-destructive",
		},
		{
			label: m.sentinel_distribution_reused(),
			count: report.reusedPasswords.length,
			className: "bg-warning",
		},
		{
			label: m.sentinel_distribution_aging(),
			count: report.oldPasswords.length,
			className: "bg-success/60",
		},
	];

	return (
		<section className="rounded-lg border bg-card">
			<div className="flex items-start gap-3 border-b p-4">
				<div className="rounded-md border bg-foreground/3 p-2">
					<ShieldCheck className="size-4 text-muted-foreground" />
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="font-medium text-sm">
						{m.dashboard_home_security_title()}
					</h2>
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{m.dashboard_home_security_description()}
					</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/security">
						{m.dashboard_home_open_sentinel()}
						<ArrowRight className="ml-1 size-3.5" />
					</Link>
				</Button>
			</div>
			<div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-center">
				<div className="shrink-0">
					<ScoreRing
						score={report.securityScore}
						gaugeLabel={m.sentinel_score_gauge_label()}
					/>
				</div>
				<div className="min-w-0 flex-1 space-y-3">
					<div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-foreground/6">
						{distribution
							.filter((bucket) => bucket.count > 0)
							.map((bucket) => (
								<div
									key={bucket.label}
									className={cn("h-full", bucket.className)}
									style={{
										width: `${totalMonitored > 0 ? (bucket.count / totalMonitored) * 100 : 0}%`,
									}}
								/>
							))}
					</div>
					<div className="flex flex-wrap gap-x-4 gap-y-1.5">
						{distribution.map((bucket) => (
							<div
								key={bucket.label}
								className="flex items-center gap-1.5 text-muted-foreground text-xs"
							>
								<span
									aria-hidden
									className={cn("size-[7px] rounded-full", bucket.className)}
								/>
								{bucket.label}
								<span className="tabular-nums">{bucket.count}</span>
							</div>
						))}
					</div>
					<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
						<span className="text-muted-foreground">
							{m.sentinel_overview_stat_passwords_monitored()}{" "}
							<span className="font-medium text-foreground tabular-nums">
								{totalMonitored}
							</span>
						</span>
						<span className="text-muted-foreground">
							{m.dashboard_home_at_risk_label()}{" "}
							<span
								className={cn(
									"font-medium tabular-nums",
									atRiskCount > 0 ? "text-warning" : "text-foreground",
								)}
							>
								{atRiskCount}
							</span>
						</span>
					</div>
				</div>
			</div>
			{report.recommendations.length > 0 ? (
				<div className="divide-y border-t">
					{report.recommendations.slice(0, 3).map((recommendation) => {
						const config = PRIORITY_ICONS[recommendation.priority];
						return (
							<div
								key={recommendation.key}
								className="flex items-center gap-3 px-4 py-2.5"
							>
								<config.icon
									className={cn("size-4 shrink-0", config.className)}
								/>
								<p className="min-w-0 flex-1 truncate text-sm">
									{getRecommendationTitle(recommendation, m)}
								</p>
							</div>
						);
					})}
				</div>
			) : null}
		</section>
	);
}
