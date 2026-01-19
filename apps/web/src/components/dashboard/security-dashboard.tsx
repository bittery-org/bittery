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
	ScrollArea,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
	AlertCircle,
	AlertTriangle,
	ArrowRight,
	CheckCircle,
	Clock,
	Copy,
	ExternalLink,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { Favicon } from "../vault/favicon";

interface SecurityDashboardProps {
	report: SecurityReport;
	isLoading: boolean;
	vaults?: Array<{ id: string; name: string }>;
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

/**
 * Score color based on value
 */
function getScoreColor(score: number): string {
	if (score >= 80) return "text-green-500";
	if (score >= 60) return "text-lime-500";
	if (score >= 40) return "text-yellow-500";
	if (score >= 20) return "text-orange-500";
	return "text-red-500";
}

/**
 * Score label for speedometer gauge
 */
function getScoreGaugeLabel(score: number): string {
	if (score >= 80) return "EXCELLENT";
	if (score >= 60) return "GOOD";
	if (score >= 40) return "FAIR";
	if (score >= 20) return "WEAK";
	return "CRITICAL";
}

/**
 * Speedometer-style gauge component with arc marker
 */
function SpeedometerGauge({
	value,
	size = 160,
}: {
	value: number;
	size?: number;
}) {
	const strokeWidth = 14;
	const radius = (size - strokeWidth) / 2;
	const centerX = size / 2;
	const centerY = size / 2;

	// Define gradient stops for the gauge
	const gradientId = "gauge-gradient";

	// Calculate marker position on the arc (0 = left, 180 = right)
	const angleRad = (value / 100) * Math.PI; // 0 to PI radians
	const markerX = centerX - Math.cos(angleRad) * radius;
	const markerY = centerY - Math.sin(angleRad) * radius;

	// Calculate triangle rotation to point inward
	const triangleRotation = (value / 100) * 180 - 90;

	return (
		<div className="relative" style={{ width: size, height: size / 2 + 10 }}>
			<svg
				width={size}
				height={size / 2 + 10}
				viewBox={`0 0 ${size} ${size / 2 + 10}`}
				aria-hidden="true"
			>
				<defs>
					<linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="#22c55e" />
						<stop offset="35%" stopColor="#84cc16" />
						<stop offset="55%" stopColor="#eab308" />
						<stop offset="75%" stopColor="#f97316" />
						<stop offset="100%" stopColor="#ef4444" />
					</linearGradient>
				</defs>
				{/* Background arc */}
				<path
					d={`M ${strokeWidth / 2} ${centerY} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${centerY}`}
					fill="none"
					stroke={`url(#${gradientId})`}
					strokeWidth={strokeWidth}
					strokeLinecap="round"
				/>
				{/* Triangle marker on the arc */}
				<g
					transform={`translate(${markerX}, ${markerY}) rotate(${triangleRotation})`}
					style={{ transition: "transform 0.5s ease-out" }}
				>
					<polygon
						points="0,-10 6,4 -6,4"
						fill="currentColor"
						className="text-foreground"
					/>
				</g>
			</svg>
			{/* Score display - centered inside the arc */}
			<div
				className="absolute flex flex-col items-center"
				style={{
					bottom: 4,
					left: "50%",
					transform: "translateX(-50%)",
				}}
			>
				<span
					className={`font-bold text-4xl leading-none ${getScoreColor(value)}`}
				>
					{value}
				</span>
				<span className="font-medium text-[10px] text-muted-foreground tracking-wider">
					{getScoreGaugeLabel(value)}
				</span>
			</div>
		</div>
	);
}

/**
 * Score gauge section - displays the speedometer
 */
function ScoreGaugeSection({
	score,
	isLoading,
}: {
	score: number;
	isLoading: boolean;
}) {
	return (
		<div className="flex justify-start">
			{isLoading ? (
				<Skeleton className="h-[90px] w-40" />
			) : (
				<SpeedometerGauge value={score} />
			)}
		</div>
	);
}

/**
 * Password strength distribution bar (1Password style)
 */
function StrengthDistributionBar({
	report,
	isLoading,
}: {
	report: SecurityReport;
	isLoading: boolean;
}) {
	const total = report.totalPasswords || 1;
	const weak = report.weakPasswords.length;
	const reused = report.reusedPasswords.length;
	const old = report.oldPasswords.length;

	// Calculate strong passwords (not weak, reused, or old)
	const problemPasswords = new Set([
		...report.weakPasswords.map((p) => p.item.id),
		...report.reusedPasswords.map((p) => p.item.id),
		...report.oldPasswords.map((p) => p.item.id),
	]);
	const strong = Math.max(0, total - problemPasswords.size);

	// Calculate percentages
	const strongPct = (strong / total) * 100;
	const weakPct = (weak / total) * 100;
	const reusedPct = (reused / total) * 100;
	const oldPct = (old / total) * 100;

	if (isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-4 w-48" />
				<Skeleton className="h-3 w-full rounded-full" />
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<h3 className="font-medium text-sm">Overall Password Strength</h3>
			<div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
				{strongPct > 0 && (
					<div
						className="h-full bg-green-500 transition-all duration-500"
						style={{ width: `${strongPct}%` }}
						title={`Strong: ${strong}`}
					/>
				)}
				{oldPct > 0 && (
					<div
						className="h-full bg-yellow-500 transition-all duration-500"
						style={{ width: `${oldPct}%` }}
						title={`Old: ${old}`}
					/>
				)}
				{reusedPct > 0 && (
					<div
						className="h-full bg-orange-500 transition-all duration-500"
						style={{ width: `${reusedPct}%` }}
						title={`Reused: ${reused}`}
					/>
				)}
				{weakPct > 0 && (
					<div
						className="h-full bg-red-500 transition-all duration-500"
						style={{ width: `${weakPct}%` }}
						title={`Weak: ${weak}`}
					/>
				)}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-4 text-muted-foreground text-xs">
				<div className="flex flex-wrap gap-4">
					<span className="flex items-center gap-1.5">
						<span className="h-2 w-2 rounded-full bg-green-500" />
						Strong ({strong})
					</span>
					<span className="flex items-center gap-1.5">
						<span className="h-2 w-2 rounded-full bg-yellow-500" />
						Old ({old})
					</span>
					<span className="flex items-center gap-1.5">
						<span className="h-2 w-2 rounded-full bg-orange-500" />
						Reused ({reused})
					</span>
					<span className="flex items-center gap-1.5">
						<span className="h-2 w-2 rounded-full bg-red-500" />
						Weak ({weak})
					</span>
				</div>
				<span>
					<span className="font-medium text-foreground">{total}</span> passwords
					analyzed
				</span>
			</div>
		</div>
	);
}

/**
 * Issue card component (1Password Watchtower style)
 */
function IssueCard({
	count,
	title,
	description,
	icon: Icon,
	iconColor,
	isLoading,
	onViewItems,
}: {
	count: number;
	title: string;
	description: string;
	icon: LucideIcon;
	iconColor: string;
	isLoading: boolean;
	onViewItems?: () => void;
}) {
	const hasIssues = count > 0;

	return (
		<Card className="flex h-full flex-col">
			<CardContent className="flex flex-1 flex-col">
				{/* Top section: Number + Icon */}
				<div className="flex items-start justify-between">
					{isLoading ? (
						<Skeleton className="h-12 w-16" />
					) : (
						<p className="font-light text-[48px] leading-none tracking-tight">
							{count}
						</p>
					)}
					<Icon
						className={`h-10 w-10 ${iconColor} opacity-30`}
						strokeWidth={1}
					/>
				</div>

				{/* Title + Description */}
				<div className="mt-3 flex-1">
					<p className="font-semibold text-[15px]">{title}</p>
					<p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
						{description}
					</p>
				</div>

				{/* View items link */}
				<div className="mt-4 border-t pt-3">
					{hasIssues && onViewItems ? (
						<button
							type="button"
							onClick={onViewItems}
							className="flex w-full items-center justify-between font-medium text-primary text-sm hover:underline"
						>
							View items
							<ArrowRight className="h-4 w-4" />
						</button>
					) : (
						<span className="flex w-full items-center justify-between text-muted-foreground text-sm">
							No issues
							<CheckCircle className="h-4 w-4 text-green-500" />
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Issue cards section (1Password Watchtower style)
 */
function IssueCardsSection({
	report,
	isLoading,
	onViewIssues,
}: {
	report: SecurityReport;
	isLoading: boolean;
	onViewIssues: (tab: "weak" | "reused" | "old") => void;
}) {
	const weakCount = report.weakPasswords.length;
	const reusedCount = report.reusedPasswords.length;
	const oldCount = report.oldPasswords.length;

	return (
		<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			<IssueCard
				count={weakCount}
				title="Weak Passwords"
				description="Weak passwords are easier to guess. Generate secure passwords to protect your accounts."
				icon={ShieldAlert}
				iconColor="text-red-500"
				isLoading={isLoading}
				onViewItems={weakCount > 0 ? () => onViewIssues("weak") : undefined}
			/>
			<IssueCard
				count={reusedCount}
				title="Reused Passwords"
				description="Don't use the same password across multiple websites. Generate unique passwords to increase your security."
				icon={Copy}
				iconColor="text-orange-500"
				isLoading={isLoading}
				onViewItems={reusedCount > 0 ? () => onViewIssues("reused") : undefined}
			/>
			<IssueCard
				count={oldCount}
				title="Old Passwords"
				description="Passwords older than 90 days should be updated regularly for better security."
				icon={Clock}
				iconColor="text-amber-500"
				isLoading={isLoading}
				onViewItems={oldCount > 0 ? () => onViewIssues("old") : undefined}
			/>
		</div>
	);
}

/**
 * Password issue list item
 */
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
			className="block"
		>
			<div className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50">
				<Favicon
					url={item.url}
					title={item.title}
					category={item.category}
					size="sm"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium">{item.title}</span>
						{issue.analysis && (
							<Badge
								variant="outline"
								className={strengthToTextColor(issue.analysis.strength)}
							>
								{strengthToLabel(issue.analysis.strength)}
							</Badge>
						)}
					</div>
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<span className="truncate">{vaultName}</span>
						{issue.issueType === "reused" && issue.reusedCount && (
							<>
								<span>·</span>
								<span>Used in {issue.reusedCount} items</span>
							</>
						)}
						{issue.issueType === "old" && issue.daysSinceUpdate && (
							<>
								<span>·</span>
								<span>{issue.daysSinceUpdate} days old</span>
							</>
						)}
						{issue.analysis?.crackTime && (
							<>
								<span>·</span>
								<span>Crack time: {issue.analysis.crackTime}</span>
							</>
						)}
					</div>
				</div>
				<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
			</div>
		</Link>
	);
}

/**
 * Password issues list
 */
function PasswordIssuesList({
	issues,
	vaults,
	emptyMessage,
	emptyIcon: EmptyIcon,
}: {
	issues: PasswordIssue[];
	vaults: Array<{ id: string; name: string }>;
	emptyMessage: string;
	emptyIcon: LucideIcon;
}) {
	if (issues.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-8 text-center">
				<EmptyIcon className="mb-2 h-12 w-12 text-green-500" />
				<p className="text-muted-foreground">{emptyMessage}</p>
			</div>
		);
	}

	return (
		<ScrollArea className="h-[300px] pr-4">
			<div className="space-y-2">
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

/**
 * Recommendations section
 */
function RecommendationsSection({ report }: { report: SecurityReport }) {
	const priorityConfig = {
		high: {
			icon: AlertCircle,
			iconColor: "text-red-500",
			bgColor: "bg-red-500/10",
			borderColor: "border-l-red-500",
			label: "High Priority",
		},
		medium: {
			icon: AlertTriangle,
			iconColor: "text-yellow-500",
			bgColor: "bg-yellow-500/10",
			borderColor: "border-l-yellow-500",
			label: "Medium",
		},
		low: {
			icon: CheckCircle,
			iconColor: "text-green-500",
			bgColor: "bg-green-500/10",
			borderColor: "border-l-green-500",
			label: "Low",
		},
	};

	if (report.recommendations.length === 0) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<div className="rounded-lg bg-primary/10 p-2">
						<ShieldCheck className="h-5 w-5 text-primary" />
					</div>
					Recommendations
				</CardTitle>
				<CardDescription>
					Actionable steps to improve your password security
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{report.recommendations.map((rec, index) => {
						const config = priorityConfig[rec.priority];
						const Icon = config.icon;
						return (
							<div
								key={index}
								className={`flex gap-4 rounded-lg border-l-4 bg-muted/30 p-4 ${config.borderColor}`}
							>
								<div className={`rounded-lg p-2 ${config.bgColor} h-fit`}>
									<Icon className={`h-4 w-4 ${config.iconColor}`} />
								</div>
								<div className="min-w-0 flex-1">
									<div className="mb-1 flex items-center gap-2">
										<p className="font-medium">{rec.title}</p>
										<Badge
											variant="outline"
											className={`px-1.5 py-0 text-[10px] ${config.iconColor}`}
										>
											{config.label}
										</Badge>
									</div>
									<p className="text-muted-foreground text-sm">
										{rec.description}
									</p>
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Main Security Dashboard component (1Password Watchtower style)
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
			{/* Score gauge + Password strength distribution bar */}
			<div className="flex flex-col items-start gap-6 md:flex-row md:items-center">
				<ScoreGaugeSection score={report.securityScore} isLoading={isLoading} />
				<div className="w-full flex-1">
					<StrengthDistributionBar report={report} isLoading={isLoading} />
				</div>
			</div>

			{/* Issue cards grid (1Password Watchtower style) */}
			<IssueCardsSection
				report={report}
				isLoading={isLoading}
				onViewIssues={handleViewIssues}
			/>

			{/* Detailed issues list (shown when clicking View items) */}
			{showDetails && !isLoading && (
				<Card>
					<CardHeader className="flex flex-row items-center justify-between">
						<div>
							<CardTitle>Password Issues</CardTitle>
							<CardDescription>
								Review and fix security issues with your passwords
							</CardDescription>
						</div>
						<button
							type="button"
							onClick={() => setShowDetails(false)}
							className="text-muted-foreground text-sm hover:text-foreground"
						>
							Hide
						</button>
					</CardHeader>
					<CardContent>
						<Tabs
							value={activeTab}
							onValueChange={(v) => setActiveTab(v as typeof activeTab)}
							className="w-full"
						>
							<TabsList className="grid w-full grid-cols-3">
								<TabsTrigger value="weak" className="flex items-center gap-2">
									<ShieldAlert className="h-4 w-4" />
									Weak
									{report.weakPasswords.length > 0 && (
										<Badge variant="destructive" className="ml-1">
											{report.weakPasswords.length}
										</Badge>
									)}
								</TabsTrigger>
								<TabsTrigger value="reused" className="flex items-center gap-2">
									<Copy className="h-4 w-4" />
									Reused
									{report.reusedPasswords.length > 0 && (
										<Badge
											variant="secondary"
											className="ml-1 bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400"
										>
											{report.reusedPasswords.length}
										</Badge>
									)}
								</TabsTrigger>
								<TabsTrigger value="old" className="flex items-center gap-2">
									<Clock className="h-4 w-4" />
									Old
									{report.oldPasswords.length > 0 && (
										<Badge
											variant="secondary"
											className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"
										>
											{report.oldPasswords.length}
										</Badge>
									)}
								</TabsTrigger>
							</TabsList>

							<TabsContent value="weak" className="mt-4">
								<PasswordIssuesList
									issues={report.weakPasswords}
									vaults={vaults}
									emptyMessage="No weak passwords found. Great job!"
									emptyIcon={ShieldCheck}
								/>
							</TabsContent>

							<TabsContent value="reused" className="mt-4">
								<PasswordIssuesList
									issues={report.reusedPasswords}
									vaults={vaults}
									emptyMessage="No reused passwords found. Each password is unique!"
									emptyIcon={CheckCircle}
								/>
							</TabsContent>

							<TabsContent value="old" className="mt-4">
								<PasswordIssuesList
									issues={report.oldPasswords}
									vaults={vaults}
									emptyMessage="No old passwords found. Your passwords are up to date!"
									emptyIcon={RefreshCw}
								/>
							</TabsContent>
						</Tabs>
					</CardContent>
				</Card>
			)}

			{/* Recommendations */}
			{!isLoading && <RecommendationsSection report={report} />}
		</div>
	);
}
