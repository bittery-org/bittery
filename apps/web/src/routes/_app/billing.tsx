import type { CloudPlanId } from "@bittery/api/billing/plans";
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
import { formatDate } from "@/lib/i18n-format";
import { m as messages } from "@/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

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
		meta: [{ title: messages["billing.page.meta_title"]() }],
	}),
});

const plans = [
	{
		id: "free" as const,
		nameKey: "billing.plan.free.name",
		descriptionKey: "billing.plan.free.description",
		featureKeys: [
			"billing.plan.free.feature.unlimited_passwords",
			"billing.plan.free.feature.one_vault",
			"billing.plan.free.feature.single_user",
			"billing.plan.free.feature.cross_platform_sync",
		],
		icon: User,
		memberLimit: 1,
		highlighted: false,
	},
	{
		id: "personal" as const,
		nameKey: "billing.plan.personal.name",
		descriptionKey: "billing.plan.personal.description",
		featureKeys: [
			"billing.plan.personal.feature.everything_in_free",
			"billing.plan.personal.feature.sentinel_dashboard",
			"billing.plan.personal.feature.five_share_links",
			"billing.plan.personal.feature.file_attachments",
		],
		icon: StarSparkle,
		memberLimit: 1,
		highlighted: true,
	},
	{
		id: "family" as const,
		nameKey: "billing.plan.family.name",
		descriptionKey: "billing.plan.family.description",
		featureKeys: [
			"billing.plan.family.feature.everything_in_personal",
			"billing.plan.family.feature.up_to_six_members",
			"billing.plan.family.feature.five_shared_vaults",
			"billing.plan.family.feature.unlimited_share_links",
		],
		icon: Users,
		memberLimit: 6,
		highlighted: false,
	},
	{
		id: "team" as const,
		nameKey: "billing.plan.team.name",
		descriptionKey: "billing.plan.team.description",
		featureKeys: [
			"billing.plan.team.feature.everything_in_family",
			"billing.plan.team.feature.unlimited_members",
			"billing.plan.team.feature.unlimited_shared_vaults",
			"billing.plan.team.feature.per_seat_billing",
		],
		icon: Shield,
		memberLimit: null,
		highlighted: false,
	},
] as const;

type PlanId = (typeof plans)[number]["id"];
const paidPlanIds = ["personal", "family", "team"] as const;

type BillingMessageCatalog = ReturnType<typeof useI18n>["m"];

function getPlanLabel(planId: CloudPlanId | string, m: BillingMessageCatalog): string {
	switch (planId) {
		case "free":
			return m["billing.plan.free.name"]();
		case "personal":
			return m["billing.plan.personal.name"]();
		case "family":
			return m["billing.plan.family.name"]();
		case "team":
			return m["billing.plan.team.name"]();
		default:
			return planId;
	}
}

function getStatusDisplay(status: string, m: BillingMessageCatalog) {
	switch (status) {
		case "active":
			return { label: m["billing.status.active"](), variant: "default" as const };
		case "trialing":
			return { label: m["billing.status.trialing"](), variant: "secondary" as const };
		case "past_due":
			return {
				label: m["billing.status.past_due"](),
				variant: "destructive" as const,
			};
		case "canceled":
			return { label: m["billing.status.canceled"](), variant: "outline" as const };
		case "unpaid":
			return {
				label: m["billing.status.unpaid"](),
				variant: "destructive" as const,
			};
		case "incomplete":
			return {
				label: m["billing.status.incomplete"](),
				variant: "outline" as const,
			};
		default:
			return { label: m["billing.status.none"](), variant: "outline" as const };
	}
}

function getMemberLimitLabel(
	memberLimit: number | null,
	m: BillingMessageCatalog,
): string {
	if (memberLimit === null) {
		return m["billing.plan.member_limit.unlimited"]();
	}

	return memberLimit === 1
		? m["billing.plan.member_limit.single"]({ count: memberLimit })
		: m["billing.plan.member_limit.plural"]({ count: memberLimit });
}

function getSeatsLabel(seatsPurchased: number, m: BillingMessageCatalog): string {
	return seatsPurchased === 1
		? m["billing.subscription.seats.single"]({ count: seatsPurchased })
		: m["billing.subscription.seats.plural"]({ count: seatsPurchased });
}

function getShareLinksLimitLabel(limit: number, m: BillingMessageCatalog): string {
	const countLabel = limit === 0 ? m["billing.limits.none"]() : String(limit);
	const label =
		limit === 1
			? m["billing.limits.share_links.single"]()
			: m["billing.limits.share_links.plural"]();
	return `${countLabel} ${label}`;
}

function getSharedVaultsLimitLabel(limit: number, m: BillingMessageCatalog): string {
	const countLabel = limit === 0 ? m["billing.limits.none"]() : String(limit);
	const label =
		limit === 1
			? m["billing.limits.shared_vaults.single"]()
			: m["billing.limits.shared_vaults.plural"]();
	return `${countLabel} ${label}`;
}

function formatEntitlementLabel(key: string, m: BillingMessageCatalog): string {
	switch (key) {
		case "sentinel":
			return m["billing.entitlement.sentinel"]();
		case "team_management":
			return m["billing.entitlement.team_management"]();
		case "vault_sharing":
			return m["billing.entitlement.vault_sharing"]();
		case "share_links":
			return m["billing.entitlement.share_links"]();
		case "billing_portal":
			return m["billing.entitlement.billing_portal"]();
		case "attachments":
			return m["billing.entitlement.attachments"]();
		default:
			return key;
	}
}

function BillingRoute() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const { checkout } = Route.useSearch();
	const { m } = useI18n();

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
			toast.error(m["billing.toast.checkout.url_missing"]());
		},
		onError: () => {
			toast.error(m["billing.toast.checkout.start_failed"]());
		},
	});

	const portalMutation = useMutation({
		mutationFn: () => trpcClient.billing.createPortalSession.mutate(),
		onSuccess: (result) => {
			window.location.href = result.url;
		},
		onError: () => {
			toast.error(m["billing.toast.portal.open_failed"]());
		},
	});

	useEffect(() => {
		if (checkout !== "success") return;
		queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
		queryClient.invalidateQueries({
			queryKey: trpc.billing.entitlements.queryKey(),
		});
		toast.success(m["billing.toast.checkout.refreshing"]());
	}, [checkout, m, queryClient, trpc]);

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
					<p className="mt-3 font-medium">{m["billing.error.load_status.title"]()}</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{m["billing.error.load_status.description"]()}
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-4"
						onClick={() => billingQuery.refetch()}
					>
						{m["billing.error.load_status.retry"]()}
					</Button>
				</div>
			</div>
		);
	}

	const billing = billingQuery.data;
	const statusDisplay = getStatusDisplay(billing.status, m);
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
						{m["billing.plan.current"]()}
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
					{m["billing.plan.current"]()}
				</Badge>
			);
		}

		if (isCurrent && !isActive) {
			return (
				<Button
					size="sm"
					onClick={() =>
						checkoutMutation.mutate(planId as (typeof paidPlanIds)[number])
					}
					disabled={isPending}
				>
					{m["billing.plan.complete_checkout"]()}
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
					checkoutMutation.mutate(planId as (typeof paidPlanIds)[number])
				}
				disabled={isPending}
			>
				{isUpgrade ? m["billing.plan.upgrade"]() : m["billing.plan.switch"]()}
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
							{m["billing.page.badge"]()}
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								{m["billing.page.heading"]()}
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								{m["billing.page.description"]()}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<CreditCard className="h-3.5 w-3.5" />
								{m["billing.page.plan_badge"]({
									planName: getPlanLabel(billing.plan, m),
								})}
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
									{m["billing.page.cancels"]({
										date: formatDate(billing.currentPeriodEnd),
									})}
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
								{m["billing.page.manage_stripe"]()}
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
						<p className="font-medium text-sm">
							{m["billing.alert.subscription_required.title"]()}
						</p>
						<p className="text-xs opacity-80">
							{m["billing.alert.subscription_required.description"]()}
						</p>
					</div>
				</div>
			)}

			{checkout === "success" && (
				<div className="flex items-start gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
					<div className="space-y-1">
						<p className="font-medium text-sm">
							{m["billing.alert.checkout_completed.title"]()}
						</p>
						<p className="text-xs opacity-80">
							{m["billing.alert.checkout_completed.description"]()}
						</p>
					</div>
				</div>
			)}

			{checkout === "cancel" && (
				<div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
					<CircleWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="space-y-1">
						<p className="font-medium text-sm">
							{m["billing.alert.checkout_canceled.title"]()}
						</p>
						<p className="text-muted-foreground text-xs">
							{m["billing.alert.checkout_canceled.description"]()}
						</p>
					</div>
				</div>
			)}

			{/* Plan Cards */}
			<div>
				<div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
					<h2 className="font-semibold text-lg tracking-tight">
						{m["billing.plans.title"]()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m["billing.plans.description"]()}
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
										<Badge className="text-[10px]">
											{m["billing.plan.popular"]()}
										</Badge>
									</div>
								)}

								<div className="mb-4 flex items-center gap-3">
									<div
										className={`flex h-9 w-9 items-center justify-center rounded-lg ${
											isCurrent ? "bg-primary/10" : "bg-muted"
										}`}
									>
										<Icon
											className={`h-4 w-4 ${
												isCurrent ? "text-primary" : "text-muted-foreground"
											}`}
										/>
									</div>
									<div>
										<p className="font-semibold text-sm">{m[plan.nameKey]()}</p>
										<p className="text-muted-foreground text-xs">
											{m[plan.descriptionKey]()}
										</p>
									</div>
								</div>

								<Separator className="mb-4" />

								<ul className="mb-6 flex-1 space-y-2.5">
									{plan.featureKeys.map((featureKey) => (
										<li
											key={featureKey}
											className="flex items-start gap-2 text-sm"
										>
											<CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
											<span className="text-muted-foreground">
												{m[featureKey]()}
											</span>
										</li>
									))}
								</ul>

								<div className="mt-auto flex items-center justify-between">
									<span className="text-muted-foreground text-xs">
										{getMemberLimitLabel(plan.memberLimit, m)}
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
							{m["billing.subscription.title"]()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m["billing.subscription.description"]()}
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
									<p className="text-muted-foreground text-xs">
										{m["billing.subscription.status"]()}
									</p>
									<div className="mt-0.5 flex items-center gap-2">
										<Badge variant={statusDisplay.variant}>
											{statusDisplay.label}
										</Badge>
										{billing.cancelAtPeriodEnd && (
											<span className="text-amber-600 text-xs dark:text-amber-400">
												{m["billing.subscription.canceling"]()}
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
												? m["billing.subscription.access_until"]()
												: m["billing.subscription.next_billing_date"]()}
										</p>
										<p className="mt-0.5 font-medium text-sm">
											{formatDate(billing.currentPeriodEnd, {
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
											{m["billing.subscription.seats_purchased"]()}
										</p>
										<p className="mt-0.5 font-medium text-sm">
											{getSeatsLabel(billing.seatsPurchased, m)}
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
							{m["billing.features.title"]()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m["billing.features.description"]()}
						</p>
					</div>

					<div className="rounded-xl border bg-card p-5">
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{Object.entries(entitlementsQuery.data.entitlements).map(
								([key, enabled]) => (
									<div key={key} className="flex items-center gap-2.5 text-sm">
										{enabled ? (
											<CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
										) : (
											<div className="h-4 w-4 shrink-0 rounded-full border-2 border-muted" />
										)}
										<span
											className={enabled ? "" : "text-muted-foreground line-through"}
										>
											{formatEntitlementLabel(key, m)}
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
													{getShareLinksLimitLabel(
														entitlementsQuery.data.limits.share_links,
														m,
													)}
												</span>
											</div>
										)}
									{entitlementsQuery.data.limits.shared_vaults !== null &&
										entitlementsQuery.data.limits.shared_vaults !== undefined && (
											<div className="text-muted-foreground text-xs">
												<span className="font-medium text-foreground">
													{getSharedVaultsLimitLabel(
														entitlementsQuery.data.limits.shared_vaults,
														m,
													)}
												</span>
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
