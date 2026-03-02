import {
	Briefcase,
	Check,
	ChevronDown,
	Heart,
	Lock,
	Sparkle,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ─── Types & Data ───────────────────────────────────────────────── */

type PlanId = "free" | "personal" | "family" | "team";

type PlanFeature = {
	label: string;
	values: Record<PlanId, string | boolean>;
};

const featureCategories: Array<{
	name: string;
	features: PlanFeature[];
}> = [
	{
		name: "Vaults & Items",
		features: [
			{
				label: "Vaults",
				values: {
					free: "1",
					personal: "Unlimited",
					family: "Unlimited",
					team: "Unlimited",
				},
			},
			{
				label: "Items per vault",
				values: {
					free: "50",
					personal: "Unlimited",
					family: "Unlimited",
					team: "Unlimited",
				},
			},
			{
				label: "Item types",
				values: {
					free: "Logins only",
					personal: "All types",
					family: "All types",
					team: "All types",
				},
			},
			{
				label: "Storage",
				values: {
					free: false,
					personal: "250 MB",
					family: "1 GB",
					team: "2 GB",
				},
			},
			{
				label: "Max file size",
				values: {
					free: false,
					personal: "10 MB",
					family: "25 MB",
					team: "50 MB",
				},
			},
		],
	},
	{
		name: "Security",
		features: [
			{
				label: "Zero-knowledge encryption",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Two-factor authentication",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Passkey support",
				values: { free: false, personal: true, family: true, team: true },
			},
			{
				label: "Emergency Kit & Recovery",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Breach monitoring",
				values: { free: false, personal: true, family: true, team: true },
			},
		],
	},
	{
		name: "Sharing & Collaboration",
		features: [
			{
				label: "Secure sharing links",
				values: {
					free: false,
					personal: "5 active",
					family: "Unlimited",
					team: "Unlimited",
				},
			},
			{
				label: "Shared vaults",
				values: {
					free: false,
					personal: false,
					family: "5",
					team: "Unlimited",
				},
			},
			{
				label: "Team members",
				values: {
					free: false,
					personal: false,
					family: "Up to 6",
					team: "Unlimited",
				},
			},
			{
				label: "Role-based access",
				values: { free: false, personal: false, family: true, team: true },
			},
		],
	},
	{
		name: "Apps & Devices",
		features: [
			{
				label: "Web app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Desktop app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Browser extension",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Mobile app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Synced devices",
				values: {
					free: "2",
					personal: "Unlimited",
					family: "Unlimited",
					team: "Unlimited",
				},
			},
		],
	},
	{
		name: "Admin & Support",
		features: [
			{
				label: "Priority support",
				values: { free: false, personal: true, family: true, team: true },
			},
			{
				label: "Admin console",
				values: { free: false, personal: false, family: false, team: true },
			},
			{
				label: "Activity logs",
				values: { free: false, personal: false, family: false, team: true },
			},
			{
				label: "Custom policies",
				values: { free: false, personal: false, family: false, team: true },
			},
		],
	},
];

const plans: Array<{
	id: PlanId;
	name: string;
	priceLabel: string;
	priceSuffix?: string;
	isPopular?: boolean;
	icon: React.ComponentType<{ className?: string }>;
}> = [
	{
		id: "free",
		name: "Free",
		priceLabel: "$0",
		icon: Lock,
	},
	{
		id: "personal",
		name: "Personal",
		priceLabel: "$3",
		priceSuffix: "/mo",
		isPopular: true,
		icon: Sparkle,
	},
	{
		id: "family",
		name: "Family",
		priceLabel: "$7",
		priceSuffix: "/mo",
		icon: Heart,
	},
	{
		id: "team",
		name: "Team",
		priceLabel: "$9",
		priceSuffix: "/user/mo",
		icon: Briefcase,
	},
];

/* ─── Feature Value Cell ─────────────────────────────────────────── */

function FeatureValue({ value }: { value: string | boolean }) {
	if (value === true) {
		return (
			<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
				<Check className="size-3" />
			</span>
		);
	}
	if (value === false) {
		return (
			<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground/40">
				<X className="size-2.5" />
			</span>
		);
	}
	return (
		<span className="font-medium text-foreground text-xs">{value}</span>
	);
}

/* ─── Desktop Table ──────────────────────────────────────────────── */

function DesktopComparison() {
	return (
		<div className="hidden lg:block">
			{/* Plan Headers */}
			<div className="sticky top-0 z-10 grid grid-cols-[1.4fr_repeat(4,1fr)] gap-0 border-b bg-background/95 backdrop-blur-sm">
				<div className="px-4 py-4">
					<span className="font-medium text-muted-foreground text-sm">
						Features
					</span>
				</div>
				{plans.map((plan) => {
					const Icon = plan.icon;
					return (
						<div
							key={plan.id}
							className={cn(
								"flex flex-col items-center px-3 py-4",
								plan.isPopular && "bg-primary/3",
							)}
						>
							<div className="flex items-center gap-2">
								<Icon className="size-4 text-muted-foreground" />
								<span className="font-semibold text-sm">{plan.name}</span>
								{plan.isPopular && (
									<Badge
										variant="default"
										className="h-5 rounded-full px-2 font-medium text-[10px]"
									>
										Popular
									</Badge>
								)}
							</div>
							<div className="mt-1 flex items-baseline gap-0.5">
								<span className="font-bold text-lg tracking-tight">
									{plan.priceLabel}
								</span>
								{plan.priceSuffix && (
									<span className="text-[11px] text-muted-foreground">
										{plan.priceSuffix}
									</span>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{/* Feature Rows */}
			{featureCategories.map((category) => (
				<div key={category.name}>
					{/* Category Header */}
					<div className="grid grid-cols-[1.4fr_repeat(4,1fr)] gap-0 border-border/40 border-b">
						<div className="px-4 py-3">
							<span className="font-semibold text-foreground text-xs uppercase tracking-wider">
								{category.name}
							</span>
						</div>
						{plans.map((plan) => (
							<div
								key={plan.id}
								className={cn(
									plan.isPopular && "bg-primary/2",
								)}
							/>
						))}
					</div>

					{/* Feature Rows */}
					{category.features.map((feature, i) => (
						<div
							key={feature.label}
							className={cn(
								"grid grid-cols-[1.4fr_repeat(4,1fr)] gap-0 border-border/20 border-b",
								i % 2 === 0 && "bg-muted/20",
							)}
						>
							<div className="flex items-center px-4 py-2.5">
								<span className="text-muted-foreground text-sm">
									{feature.label}
								</span>
							</div>
							{plans.map((plan) => (
								<div
									key={plan.id}
									className={cn(
										"flex items-center justify-center px-3 py-2.5",
										plan.isPopular && "bg-primary/2",
									)}
								>
									<FeatureValue value={feature.values[plan.id]} />
								</div>
							))}
						</div>
					))}
				</div>
			))}
		</div>
	);
}

/* ─── Mobile Comparison ──────────────────────────────────────────── */

function MobileComparison() {
	const [expandedCategory, setExpandedCategory] = useState<string | null>(
		"Vaults & Items",
	);

	return (
		<div className="lg:hidden">
			{/* Horizontal scrollable header */}
			<div className="scrollbar-none sticky top-0 z-10 -mx-1 overflow-x-auto bg-background/95 px-1 pb-2 backdrop-blur-sm">
				<div className="grid min-w-130 grid-cols-[1.2fr_repeat(4,1fr)] gap-0 border-b">
					<div className="px-2 py-3">
						<span className="font-medium text-muted-foreground text-xs">
							Features
						</span>
					</div>
					{plans.map((plan) => (
						<div
							key={plan.id}
							className={cn(
								"flex flex-col items-center px-1 py-3",
								plan.isPopular && "bg-primary/3",
							)}
						>
							<span className="font-semibold text-xs">
								{plan.name}
							</span>
							<span className="mt-0.5 font-bold text-sm">
								{plan.priceLabel}
							</span>
						</div>
					))}
				</div>
			</div>

			{/* Accordion categories */}
			<div className="scrollbar-none -mx-1 overflow-x-auto px-1">
				{featureCategories.map((category) => {
					const isExpanded = expandedCategory === category.name;
					return (
						<div key={category.name} className="min-w-130">
							<button
								type="button"
								onClick={() =>
									setExpandedCategory(isExpanded ? null : category.name)
								}
								className="flex w-full items-center gap-2 border-border/40 border-b px-2 py-2.5 text-left"
							>
								<ChevronDown
									className={cn(
										"size-3.5 text-muted-foreground transition-transform",
										isExpanded && "rotate-180",
									)}
								/>
								<span className="font-semibold text-foreground text-xs uppercase tracking-wider">
									{category.name}
								</span>
							</button>

							<AnimatePresence initial={false}>
								{isExpanded && (
									<motion.div
										initial={{ height: 0, opacity: 0 }}
										animate={{ height: "auto", opacity: 1 }}
										exit={{ height: 0, opacity: 0 }}
										transition={{ duration: 0.25, ease: "easeInOut" }}
										className="overflow-hidden"
									>
										{category.features.map((feature, i) => (
											<div
												key={feature.label}
												className={cn(
													"grid grid-cols-[1.2fr_repeat(4,1fr)] gap-0 border-border/20 border-b",
													i % 2 === 0 && "bg-muted/20",
												)}
											>
												<div className="flex items-center px-2 py-2">
													<span className="text-muted-foreground text-xs">
														{feature.label}
													</span>
												</div>
												{plans.map((plan) => (
													<div
														key={plan.id}
														className={cn(
															"flex items-center justify-center px-1 py-2",
															plan.isPopular && "bg-primary/2",
														)}
													>
														<FeatureValue
															value={feature.values[plan.id]}
														/>
													</div>
												))}
											</div>
										))}
									</motion.div>
								)}
							</AnimatePresence>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/* ─── Main Export ─────────────────────────────────────────────────── */

export function PricingComparison() {
	const [open, setOpen] = useState(false);

	return (
		<div className="mt-10 sm:mt-14">
			{/* Toggle Button */}
			<div className="flex justify-center">
				<Button
					variant="outline"
					className="gap-2 rounded-full"
					onClick={() => setOpen(!open)}
				>
					Compare all features
					<ChevronDown
						className={cn(
							"size-4 transition-transform duration-300",
							open && "rotate-180",
						)}
					/>
				</Button>
			</div>

			{/* Comparison Table */}
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
						className="overflow-hidden"
					>
						<div className="mt-8 overflow-hidden rounded-2xl border border-border/60 bg-card">
							<DesktopComparison />
							<MobileComparison />
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
