import {
	type CloudPlanId,
	featureCategories,
	planInfo,
} from "@bittery/shared/pricing";
import {
	Badge,
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";
import { useIsMobile } from "@bittery/ui/hooks/use-mobile";
import {
	IconBriefcase as Briefcase,
	IconCheck as Check,
	IconChevronLeft as ChevronLeft,
	IconChevronRight as ChevronRight,
	IconHeart as Heart,
	IconLock as Lock,
	IconSparkles as Sparkle,
	IconX as X,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";

/* ─── Plan Data (UI-specific styling layered on shared plan info) ── */

const planStyles: Record<
	CloudPlanId,
	{
		icon: React.ComponentType<{ size?: number; className?: string }>;
		accentClass: string;
		iconBgClass: string;
		headerGradient: string;
	}
> = {
	free: {
		icon: Lock,
		accentClass: "border-border",
		iconBgClass: "bg-muted text-muted-foreground",
		headerGradient: "from-muted/60 to-transparent",
	},
	personal: {
		icon: Sparkle,
		accentClass: "border-primary/40",
		iconBgClass: "bg-primary/10 text-primary",
		headerGradient: "from-primary/8 to-transparent",
	},
	family: {
		icon: Heart,
		accentClass: "border-amber-400/40 dark:border-amber-500/30",
		iconBgClass:
			"bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
		headerGradient: "from-amber-50/80 dark:from-amber-500/5 to-transparent",
	},
	team: {
		icon: Briefcase,
		accentClass: "border-sky-400/40 dark:border-sky-500/30",
		iconBgClass: "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400",
		headerGradient: "from-sky-50/80 dark:from-sky-500/5 to-transparent",
	},
};

const plans = planInfo.map((plan) => ({
	...plan,
	...planStyles[plan.id],
}));

/* ─── Feature Cell ───────────────────────────────────────────────── */

function FeatureValue({ value }: { value: string | boolean }) {
	if (value === true) {
		return (
			<span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
				<Check size={12} />
			</span>
		);
	}
	if (value === false) {
		return (
			<span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground/40">
				<X size={10} />
			</span>
		);
	}
	return <span className="font-medium text-foreground text-xs">{value}</span>;
}

/* ─── Desktop: Side-by-Side Table ────────────────────────────────── */

function DesktopComparison({
	selectedPlan,
	onSelectPlan,
	scrollContainer,
}: {
	selectedPlan: CloudPlanId;
	onSelectPlan: (id: CloudPlanId) => void;
	scrollContainer: React.RefObject<HTMLDivElement | null>;
}) {
	const headerRef = useRef<HTMLDivElement>(null);
	const [showStickyHeader, setShowStickyHeader] = useState(false);

	useEffect(() => {
		const container = scrollContainer.current;
		if (!container || !headerRef.current) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry) {
					setShowStickyHeader(!entry.isIntersecting);
				}
			},
			{ root: container, threshold: 0 },
		);

		observer.observe(headerRef.current);
		return () => observer.disconnect();
	}, [scrollContainer]);

	return (
		<div className="mt-4">
			{/* Sticky mini-header (appears when full headers scroll out) */}
			<div
				className={cn(
					"sticky -top-px z-20 border-b bg-background/95 backdrop-blur-sm transition-all duration-200",
					showStickyHeader
						? "translate-y-0 opacity-100"
						: "pointer-events-none -translate-y-2 opacity-0",
				)}
			>
				<div className="grid grid-cols-[180px_repeat(4,1fr)] gap-0 py-2">
					<div className="flex items-center px-3">
						<span className="font-medium text-muted-foreground text-xs">
							Plans
						</span>
					</div>
					{plans.map((plan) => {
						const Icon = plan.icon;
						const isSelected = selectedPlan === plan.id;
						return (
							<div key={plan.id} className="px-1.5">
								<button
									type="button"
									onClick={() => onSelectPlan(plan.id)}
									className={cn(
										"flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 transition-all duration-150",
										isSelected
											? cn(plan.accentClass, "bg-card shadow-sm")
											: "border-transparent bg-muted/40 hover:bg-muted/60",
									)}
								>
									<div
										className={cn(
											"flex h-5 w-5 items-center justify-center rounded-md",
											isSelected
												? plan.iconBgClass
												: "bg-muted text-muted-foreground",
										)}
									>
										<Icon size={11} />
									</div>
									<span className="font-semibold text-xs">{plan.name}</span>
									<span className="text-[10px] text-muted-foreground">
										{plan.priceLabel}
									</span>
								</button>
							</div>
						);
					})}
				</div>
			</div>

			{/* Plan Header Cards */}
			<div
				ref={headerRef}
				className="grid grid-cols-[180px_repeat(4,1fr)] gap-0"
			>
				{/* Empty corner cell */}
				<div />
				{plans.map((plan) => {
					const Icon = plan.icon;
					const isSelected = selectedPlan === plan.id;
					return (
						<div key={plan.id} className="px-1.5">
							<button
								type="button"
								onClick={() => onSelectPlan(plan.id)}
								className={cn(
									"relative flex w-full flex-col items-center rounded-xl border-2 px-3 pt-5 pb-4 transition-all duration-200",
									isSelected
										? cn(plan.accentClass, "bg-card shadow-sm")
										: "border-transparent bg-muted/30 hover:bg-muted/50",
								)}
							>
								{plan.isRecommended && (
									<div className="absolute inset-x-0 -top-2.5 flex justify-center">
										<Badge
											variant="default"
											className="h-5 rounded-full px-2 font-medium text-[10px] shadow-sm"
										>
											Popular
										</Badge>
									</div>
								)}
								<div
									className={cn(
										"flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
										isSelected
											? plan.iconBgClass
											: "bg-muted text-muted-foreground",
									)}
								>
									<Icon size={18} />
								</div>
								<p className="mt-2.5 font-semibold text-sm">{plan.name}</p>
								<div className="mt-1 flex items-baseline gap-0.5">
									<span className="font-bold text-xl tracking-tight">
										{plan.priceLabel}
									</span>
									{plan.priceSuffix && (
										<span className="text-[11px] text-muted-foreground">
											{plan.priceSuffix}
										</span>
									)}
								</div>
								<p className="mt-1.5 text-center text-[11px] text-muted-foreground leading-snug">
									{plan.description}
								</p>

								{/* Selection indicator */}
								<div
									className={cn(
										"mt-3 flex h-6 w-full items-center justify-center rounded-md font-medium text-[11px] transition-all",
										isSelected
											? "bg-primary text-primary-foreground"
											: "bg-muted/60 text-muted-foreground",
									)}
								>
									{isSelected ? "Selected" : "Select"}
								</div>
							</button>
						</div>
					);
				})}
			</div>

			{/* Feature Table */}
			<div className="mt-5">
				{featureCategories.map((category) => (
					<div key={category.name} className="mb-1">
						{/* Category Header */}
						<div className="grid grid-cols-[180px_repeat(4,1fr)] gap-0">
							<div className="flex items-center px-3 py-2.5">
								<span className="font-semibold text-foreground text-xs uppercase tracking-wide">
									{category.name}
								</span>
							</div>
							{plans.map((plan) => (
								<div
									key={plan.id}
									className={cn(
										"border-transparent border-x",
										selectedPlan === plan.id && "border-x-primary/10",
									)}
								/>
							))}
						</div>

						{/* Feature Rows */}
						{category.features.map((feature, i) => (
							<div
								key={feature.label}
								className={cn(
									"grid grid-cols-[180px_repeat(4,1fr)] gap-0 rounded-lg",
									i % 2 === 0 ? "bg-muted/20" : "",
								)}
							>
								<div className="flex items-center px-3 py-2.5">
									<span className="text-muted-foreground text-xs">
										{feature.label}
									</span>
								</div>
								{plans.map((plan) => (
									<div
										key={plan.id}
										className={cn(
											"flex items-center justify-center border-transparent border-x px-2 py-2.5",
											selectedPlan === plan.id &&
												"border-x-primary/10 bg-primary/2",
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
		</div>
	);
}

/* ─── Mobile: Swipeable Cards ────────────────────────────────────── */

function MobileComparison({
	selectedPlan,
	onSelectPlan,
}: {
	selectedPlan: CloudPlanId;
	onSelectPlan: (id: CloudPlanId) => void;
}) {
	const [activePlanIndex, setActivePlanIndex] = useState(() =>
		plans.findIndex((p) => p.id === selectedPlan),
	);
	const plan = plans[activePlanIndex];
	const touchRef = useRef<{ startX: number; startY: number } | null>(null);

	if (!plan) return null;
	const Icon = plan.icon;
	const isSelected = selectedPlan === plan.id;

	const goNext = useCallback(() => {
		setActivePlanIndex((i) => Math.min(i + 1, plans.length - 1));
	}, []);

	const goPrev = useCallback(() => {
		setActivePlanIndex((i) => Math.max(i - 1, 0));
	}, []);

	const handleTouchStart = useCallback((e: React.TouchEvent) => {
		const touch = e.touches[0];
		if (touch) {
			touchRef.current = { startX: touch.clientX, startY: touch.clientY };
		}
	}, []);

	const handleTouchEnd = useCallback(
		(e: React.TouchEvent) => {
			const touch = e.changedTouches[0];
			if (!touch || !touchRef.current) return;
			const dx = touch.clientX - touchRef.current.startX;
			const dy = touch.clientY - touchRef.current.startY;
			// Only trigger if horizontal swipe is dominant and large enough
			if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
				if (dx < 0) goNext();
				else goPrev();
			}
			touchRef.current = null;
		},
		[goNext, goPrev],
	);

	return (
		<div
			className="mt-0"
			onTouchStart={handleTouchStart}
			onTouchEnd={handleTouchEnd}
		>
			{/* Sticky navigation bar */}
			<div className="sticky -top-px z-20 -mx-4 border-b bg-background/95 px-4 py-2.5 backdrop-blur-sm">
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={goPrev}
						disabled={activePlanIndex === 0}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted disabled:opacity-30"
					>
						<ChevronLeft size={16} />
					</button>

					<div className="flex items-center gap-2">
						{plans.map((p, i) => {
							const PIcon = p.icon;
							const isCurrent = i === activePlanIndex;
							return (
								<button
									key={p.id}
									type="button"
									onClick={() => setActivePlanIndex(i)}
									className={cn(
										"flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200",
										isCurrent
											? "bg-primary/10 text-primary"
											: "text-muted-foreground/50 hover:text-muted-foreground",
									)}
								>
									<PIcon size={12} />
									<span
										className={cn(
											"font-medium text-[11px] transition-all duration-200",
											isCurrent
												? "max-w-20 opacity-100"
												: "max-w-0 overflow-hidden opacity-0",
										)}
									>
										{p.name}
									</span>
								</button>
							);
						})}
					</div>

					<button
						type="button"
						onClick={goNext}
						disabled={activePlanIndex === plans.length - 1}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted disabled:opacity-30"
					>
						<ChevronRight size={16} />
					</button>
				</div>
			</div>

			{/* Plan Card */}
			<div
				className={cn(
					"mt-3 rounded-2xl border-2 p-5 transition-all duration-300",
					isSelected
						? cn(plan.accentClass, "bg-card shadow-sm")
						: "border-border bg-card",
				)}
			>
				{/* Header */}
				<div
					className={cn(
						"-mx-5 -mt-5 mb-4 rounded-t-[14px] bg-linear-to-b px-5 pt-5 pb-5",
						plan.headerGradient,
					)}
				>
					<div className="flex items-start justify-between">
						<div className="flex items-center gap-3">
							<div
								className={cn(
									"flex h-10 w-10 items-center justify-center rounded-xl",
									plan.iconBgClass,
								)}
							>
								<Icon size={18} />
							</div>
							<div>
								<div className="flex items-center gap-2">
									<p className="font-semibold text-base">{plan.name}</p>
									{plan.isRecommended && (
										<Badge
											variant="default"
											className="h-5 rounded-full px-2 font-medium text-[10px]"
										>
											Popular
										</Badge>
									)}
								</div>
								<p className="mt-0.5 text-muted-foreground text-xs">
									{plan.description}
								</p>
							</div>
						</div>
					</div>
					<div className="mt-3 flex items-baseline gap-0.5">
						<span className="font-bold text-3xl tracking-tight">
							{plan.priceLabel}
						</span>
						{plan.priceSuffix && (
							<span className="text-muted-foreground text-sm">
								{plan.priceSuffix}
							</span>
						)}
					</div>
				</div>

				{/* Features */}
				<div className="space-y-4">
					{featureCategories.map((category) => (
						<div key={category.name}>
							<p className="mb-2 font-semibold text-[11px] text-muted-foreground/70 uppercase tracking-wider">
								{category.name}
							</p>
							<div className="space-y-0">
								{category.features.map((feature, i) => {
									const value = feature.values[plan.id];
									return (
										<div
											key={feature.label}
											className={cn(
												"flex items-center justify-between rounded-lg px-2.5 py-2",
												i % 2 === 0 && "bg-muted/30",
											)}
										>
											<span className="text-muted-foreground text-xs">
												{feature.label}
											</span>
											<FeatureValue value={value} />
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>

				{/* Select button */}
				<button
					type="button"
					onClick={() => onSelectPlan(plan.id)}
					className={cn(
						"mt-5 flex h-10 w-full items-center justify-center rounded-xl font-medium text-sm transition-all",
						isSelected
							? "bg-primary text-primary-foreground shadow-sm"
							: "bg-muted text-foreground hover:bg-muted/80",
					)}
				>
					{isSelected ? (
						<span className="flex items-center gap-1.5">
							<Check size={14} />
							Selected
						</span>
					) : (
						`Select ${plan.name}`
					)}
				</button>
			</div>
		</div>
	);
}

/* ─── Main Dialog ────────────────────────────────────────────────── */

export default function PlanComparisonDialog({
	open,
	onOpenChange,
	selectedPlan,
	onSelectPlan,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedPlan: CloudPlanId;
	onSelectPlan: (id: CloudPlanId) => void;
}) {
	const isMobile = useIsMobile();
	const scrollRef = useRef<HTMLDivElement>(null);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-dvh max-h-dvh w-dvw max-w-dvw flex-col gap-0 rounded-none border-0 p-0 sm:max-w-dvw">
				{/* Fixed header */}
				<div className="flex-none border-b">
					<div
						className={cn(
							"mx-auto flex items-center justify-between py-3",
							isMobile ? "px-4" : "max-w-5xl px-8",
						)}
					>
						<DialogHeader className="flex-row items-center gap-3 sm:text-left">
							<DialogTitle className="text-base">Compare Plans</DialogTitle>
							<DialogDescription className="hidden text-xs sm:block">
								All plans include zero-knowledge encryption
							</DialogDescription>
						</DialogHeader>
						{!isMobile && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 gap-1 px-2.5 text-muted-foreground text-xs"
								onClick={() => onOpenChange(false)}
							>
								Close
							</Button>
						)}
					</div>
				</div>

				{/* Scrollable content */}
				<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
					<div
						className={cn("mx-auto pb-6", isMobile ? "px-4" : "max-w-5xl px-8")}
					>
						{isMobile ? (
							<MobileComparison
								selectedPlan={selectedPlan}
								onSelectPlan={(id) => {
									onSelectPlan(id);
								}}
							/>
						) : (
							<DesktopComparison
								selectedPlan={selectedPlan}
								onSelectPlan={(id) => {
									onSelectPlan(id);
								}}
								scrollContainer={scrollRef}
							/>
						)}
					</div>
				</div>

				{/* Fixed footer */}
				<div className="flex-none border-t bg-muted/30">
					<div
						className={cn(
							"mx-auto flex items-center justify-between py-3",
							isMobile ? "px-4" : "max-w-5xl px-8",
						)}
					>
						<p className="text-muted-foreground text-xs">
							All plans include end-to-end encryption &amp; cross-platform
							access.
						</p>
						<Button
							type="button"
							className="h-8 px-5 font-medium text-xs"
							onClick={() => onOpenChange(false)}
						>
							Done
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
