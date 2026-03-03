import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { Badge, Button, Separator, Skeleton, toast } from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconCircleWarningOutlineDuo18 as CircleWarning,
	IconCreditCardLockOutlineDuo18 as CreditCard,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconMagicShieldOutlineDuo18 as Shield,
	IconStarSparkle2OutlineDuo18 as StarSparkle,
	IconUserOutlineDuo18 as User,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";

export const Route = createFileRoute("/_app/billing")({
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			context.trpc.billing.entitlements.queryOptions(),
		);

		if (access.mode !== "cloud") {
			throw redirect({ to: "/home" });
		}

		const me = await context.queryClient.ensureQueryData(
			context.trpc.auth.me.queryOptions(),
		);
		if (me.role !== "owner" && me.role !== "admin") {
			throw redirect({ to: "/team" });
		}
	},
	component: BillingRoute,
	validateSearch: z.object({
		checkout: z.string().optional(),
	}),
	head: () => ({
		meta: [{ title: "Billing - Bittery" }],
	}),
});

const plans = [
	{
		id: "free" as const,
		name: "Free",
		description: "For individuals getting started",
		features: [
			"Unlimited passwords",
			"1 vault",
			"Single user",
			"Cross-platform sync",
		],
		icon: User,
		memberLimit: 1,
		highlighted: false,
	},
	{
		id: "personal" as const,
		name: "Personal",
		description: "For power users who want more",
		features: [
			"Everything in Free",
			"Sentinel security dashboard",
			"5 share links",
			"File attachments",
		],
		icon: StarSparkle,
		memberLimit: 1,
		highlighted: true,
	},
	{
		id: "family" as const,
		name: "Family",
		description: "Share securely with loved ones",
		features: [
			"Everything in Personal",
			"Up to 6 members",
			"5 shared vaults",
			"Unlimited share links",
		],
		icon: Users,
		memberLimit: 6,
		highlighted: false,
	},
	{
		id: "team" as const,
		name: "Team",
		description: "For teams and organizations",
		features: [
			"Everything in Family",
			"Unlimited members",
			"Unlimited shared vaults",
			"Per-seat billing",
		],
		icon: Shield,
		memberLimit: null,
		highlighted: false,
	},
];

type PlanId = (typeof plans)[number]["id"];
const paidPlanIds = ["personal", "family", "team"] as const;

function getStatusDisplay(status: string) {
	switch (status) {
		case "active":
			return { label: "Active", variant: "default" as const };
		case "trialing":
			return { label: "Trial", variant: "secondary" as const };
		case "past_due":
			return { label: "Past Due", variant: "destructive" as const };
		case "canceled":
			return { label: "Canceled", variant: "outline" as const };
		case "unpaid":
			return { label: "Unpaid", variant: "destructive" as const };
		case "incomplete":
			return { label: "Incomplete", variant: "outline" as const };
		default:
			return { label: "None", variant: "outline" as const };
	}
}

function BillingRoute() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const { checkout } = Route.useSearch();

	const billingQuery = useQuery(trpc.billing.status.queryOptions());
	const entitlementsQuery = useQuery(trpc.billing.entitlements.queryOptions());

	const checkoutMutation = useMutation({
		mutationFn: (plan: (typeof paidPlanIds)[number]) =>
			trpcClient.billing.createCheckoutSession.mutate({ plan }),
		onSuccess: (result) => {
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			toast.error("Stripe checkout did not return a URL");
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to start checkout");
		},
	});

	const portalMutation = useMutation({
		mutationFn: () => trpcClient.billing.createPortalSession.mutate(),
		onSuccess: (result) => {
			window.location.href = result.url;
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to open Stripe billing portal");
		},
	});

	useEffect(() => {
		if (checkout !== "success") return;
		queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
		queryClient.invalidateQueries({
			queryKey: trpc.billing.entitlements.queryKey(),
		});
		toast.success("Checkout completed. Refreshing billing status...");
	}, [checkout, queryClient, trpc]);

	if (billingQuery.isLoading) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-6">
				<Skeleton className="h-48 w-full rounded-2xl" />
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<Skeleton className="h-64" />
					<Skeleton className="h-64" />
					<Skeleton className="h-64" />
					<Skeleton className="h-64" />
				</div>
			</div>
		);
	}

	if (billingQuery.error || !billingQuery.data) {
		return (
			<div className="mx-auto w-full max-w-6xl">
				<div className="rounded-2xl border bg-card p-8 text-center">
					<CircleWarning className="mx-auto h-8 w-8 text-muted-foreground" />
					<p className="mt-3 font-medium">Failed to load billing status</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Please try again later or contact support.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-4"
						onClick={() => billingQuery.refetch()}
					>
						Retry
					</Button>
				</div>
			</div>
		);
	}

	const billing = billingQuery.data;
	const statusDisplay = getStatusDisplay(billing.status);
	const isPending = checkoutMutation.isPending || portalMutation.isPending;

	const getButtonForPlan = (planId: PlanId) => {
		const isCurrent = billing.plan === planId;
		const isActive = billing.isActive;

		if (planId === "free") {
			if (isCurrent) {
				return (
					<Badge
						variant="outline"
						className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
					>
						<CheckCircle className="mr-1 h-3 w-3" />
						Current Plan
					</Badge>
				);
			}
			return null;
		}

		if (isCurrent && isActive) {
			return (
				<Badge
					variant="outline"
					className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
				>
					<CheckCircle className="mr-1 h-3 w-3" />
					Current Plan
				</Badge>
			);
		}

		if (isCurrent && !isActive) {
			return (
				<Button
					size="sm"
					onClick={() =>
						checkoutMutation.mutate(
							planId as (typeof paidPlanIds)[number],
						)
					}
					disabled={isPending}
				>
					Complete Checkout
				</Button>
			);
		}

		const planOrder: PlanId[] = ["free", "personal", "family", "team"];
		const currentIndex = planOrder.indexOf(billing.plan);
		const targetIndex = planOrder.indexOf(planId);
		const isUpgrade = targetIndex > currentIndex;

		return (
			<Button
				size="sm"
				variant={isUpgrade ? "default" : "outline"}
				onClick={() =>
					checkoutMutation.mutate(
						planId as (typeof paidPlanIds)[number],
					)
				}
				disabled={isPending}
			>
				{isUpgrade ? "Upgrade" : "Switch"}
			</Button>
		);
	};

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-linear-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-4">
						<Badge variant="secondary" className="w-fit">
							Billing
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								Plan & Billing
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								Manage your subscription, view your current plan, and upgrade to
								unlock premium features.
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<CreditCard className="h-3.5 w-3.5" />
								<span className="capitalize">{billing.plan}</span> plan
							</div>
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<Badge
									variant={statusDisplay.variant}
									className="h-auto px-1.5 py-0 text-[10px]"
								>
									{statusDisplay.label}
								</Badge>
							</div>
							{billing.cancelAtPeriodEnd && billing.currentPeriodEnd && (
								<div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/40 bg-amber-50/80 px-2.5 py-1 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
									<CircleWarning className="h-3.5 w-3.5" />
									Cancels{" "}
									{new Date(billing.currentPeriodEnd).toLocaleDateString()}
								</div>
							)}
						</div>
					</div>

					{billing.stripeCustomerId && (
						<div className="flex flex-wrap gap-2 lg:justify-end">
							<Button
								variant="outline"
								size="sm"
								onClick={() => portalMutation.mutate()}
								disabled={isPending}
							>
								<ExternalLink className="mr-2 h-3.5 w-3.5" />
								Manage in Stripe
							</Button>
						</div>
					)}
				</div>
			</section>

			{/* Checkout Alerts */}
			{billing.requiresPayment && !billing.isActive && (
				<div className="flex items-start gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
					<CircleWarning className="mt-0.5 h-4 w-4 shrink-0" />
					<div className="space-y-1">
						<p className="font-medium text-sm">Subscription required</p>
						<p className="text-xs opacity-80">
							Your selected paid plan requires an active subscription. Complete
							checkout below to unlock all premium features.
						</p>
					</div>
				</div>
			)}

			{checkout === "success" && (
				<div className="flex items-start gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
					<div className="space-y-1">
						<p className="font-medium text-sm">Checkout completed</p>
						<p className="text-xs opacity-80">
							Your billing status may take a few seconds to update.
						</p>
					</div>
				</div>
			)}

			{checkout === "cancel" && (
				<div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
					<CircleWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="space-y-1">
						<p className="font-medium text-sm">Checkout canceled</p>
						<p className="text-muted-foreground text-xs">
							No worries — you can resume anytime by selecting a plan below.
						</p>
					</div>
				</div>
			)}

			{/* Plan Cards */}
			<div>
				<div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
					<h2 className="font-semibold text-lg tracking-tight">
						Choose Your Plan
					</h2>
					<p className="text-muted-foreground text-sm">
						Select the plan that best fits your needs.
					</p>
				</div>

				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{plans.map((plan) => {
						const isCurrent = billing.plan === plan.id;
						const Icon = plan.icon;

						return (
							<div
								key={plan.id}
								className={`relative flex flex-col rounded-xl border p-5 transition-colors ${
									isCurrent
										? "border-primary/40 bg-primary/3 ring-1 ring-primary/20"
										: "bg-card hover:border-primary/20"
								}`}
							>
								{plan.highlighted && !isCurrent && (
									<div className="absolute -top-2.5 right-4">
										<Badge className="text-[10px]">Popular</Badge>
									</div>
								)}

								<div className="mb-4 flex items-center gap-3">
									<div
										className={`flex h-9 w-9 items-center justify-center rounded-lg ${
											isCurrent
												? "bg-primary/10"
												: "bg-muted"
										}`}
									>
										<Icon
											className={`h-4 w-4 ${
												isCurrent
													? "text-primary"
													: "text-muted-foreground"
											}`}
										/>
									</div>
									<div>
										<p className="font-semibold text-sm">{plan.name}</p>
										<p className="text-muted-foreground text-xs">
											{plan.description}
										</p>
									</div>
								</div>

								<Separator className="mb-4" />

								<ul className="mb-6 flex-1 space-y-2.5">
									{plan.features.map((feature) => (
										<li
											key={feature}
											className="flex items-start gap-2 text-sm"
										>
											<CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
											<span className="text-muted-foreground">
												{feature}
											</span>
										</li>
									))}
								</ul>

								<div className="mt-auto flex items-center justify-between">
									<span className="text-muted-foreground text-xs">
										{plan.memberLimit
											? `${plan.memberLimit} member${plan.memberLimit > 1 ? "s" : ""}`
											: "Unlimited members"}
									</span>
									{getButtonForPlan(plan.id)}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Subscription Details */}
			{billing.plan !== "free" && (
				<section className="space-y-4">
					<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
						<h2 className="font-semibold text-lg tracking-tight">
							Subscription Details
						</h2>
						<p className="text-muted-foreground text-sm">
							Information about your current subscription.
						</p>
					</div>

					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{/* Status */}
						<div className="rounded-xl border bg-card p-5">
							<div className="flex items-center gap-3">
								<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
									<CheckCircle className="h-4 w-4 text-muted-foreground" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-muted-foreground text-xs">Status</p>
									<div className="mt-0.5 flex items-center gap-2">
										<Badge variant={statusDisplay.variant}>
											{statusDisplay.label}
										</Badge>
										{billing.cancelAtPeriodEnd && (
											<span className="text-amber-600 text-xs dark:text-amber-400">
												Canceling
											</span>
										)}
									</div>
								</div>
							</div>
						</div>

						{/* Billing Period */}
						{billing.currentPeriodEnd && (
							<div className="rounded-xl border bg-card p-5">
								<div className="flex items-center gap-3">
									<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
										<CreditCard className="h-4 w-4 text-muted-foreground" />
									</div>
									<div className="min-w-0 flex-1">
										<p className="text-muted-foreground text-xs">
											{billing.cancelAtPeriodEnd
												? "Access Until"
												: "Next Billing Date"}
										</p>
										<p className="mt-0.5 font-medium text-sm">
											{new Date(
												billing.currentPeriodEnd,
											).toLocaleDateString(undefined, {
												year: "numeric",
												month: "long",
												day: "numeric",
											})}
										</p>
									</div>
								</div>
							</div>
						)}

						{/* Seats */}
						{billing.seatsPurchased !== null && (
							<div className="rounded-xl border bg-card p-5">
								<div className="flex items-center gap-3">
									<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
										<Users className="h-4 w-4 text-muted-foreground" />
									</div>
									<div className="min-w-0 flex-1">
										<p className="text-muted-foreground text-xs">
											Seats Purchased
										</p>
										<p className="mt-0.5 font-medium text-sm">
											{billing.seatsPurchased} seat
											{billing.seatsPurchased !== 1 ? "s" : ""}
										</p>
									</div>
								</div>
							</div>
						)}
					</div>
				</section>
			)}

			{/* Entitlements */}
			{entitlementsQuery.data && (
				<section className="space-y-4">
					<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
						<h2 className="font-semibold text-lg tracking-tight">
							Your Features
						</h2>
						<p className="text-muted-foreground text-sm">
							Features included with your current plan.
						</p>
					</div>

					<div className="rounded-xl border bg-card p-5">
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{Object.entries(entitlementsQuery.data.entitlements).map(
								([key, enabled]) => (
									<div
										key={key}
										className="flex items-center gap-2.5 text-sm"
									>
										{enabled ? (
											<CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
										) : (
											<div className="h-4 w-4 shrink-0 rounded-full border-2 border-muted" />
										)}
										<span
											className={
												enabled
													? ""
													: "text-muted-foreground line-through"
											}
										>
											{formatEntitlementLabel(key)}
										</span>
									</div>
								),
							)}
						</div>

						{entitlementsQuery.data.limits && (
							<>
								<Separator className="my-4" />
								<div className="flex flex-wrap gap-4">
									{entitlementsQuery.data.limits.share_links !== null &&
										entitlementsQuery.data.limits.share_links !== undefined && (
											<div className="text-muted-foreground text-xs">
												<span className="font-medium text-foreground">
													{entitlementsQuery.data.limits.share_links === 0
														? "No"
														: entitlementsQuery.data.limits.share_links}
												</span>{" "}
												share link
												{entitlementsQuery.data.limits.share_links !== 1
													? "s"
													: ""}
											</div>
										)}
									{entitlementsQuery.data.limits.shared_vaults !== null &&
										entitlementsQuery.data.limits.shared_vaults !==
											undefined && (
											<div className="text-muted-foreground text-xs">
												<span className="font-medium text-foreground">
													{entitlementsQuery.data.limits.shared_vaults === 0
														? "No"
														: entitlementsQuery.data.limits.shared_vaults}
												</span>{" "}
												shared vault
												{entitlementsQuery.data.limits.shared_vaults !== 1
													? "s"
													: ""}
											</div>
										)}
								</div>
							</>
						)}
					</div>
				</section>
			)}
		</div>
	);
}

function formatEntitlementLabel(key: string): string {
	const labels: Record<string, string> = {
		sentinel: "Sentinel Security",
		team_management: "Team Management",
		vault_sharing: "Vault Sharing",
		share_links: "Share Links",
		billing_portal: "Billing Portal",
		attachments: "File Attachments",
	};
	return labels[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
