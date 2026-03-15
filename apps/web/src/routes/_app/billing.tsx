import {
	type CloudPlanId,
	planMemberLimits,
} from "@bittery/api/billing/plans";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Progress,
	Separator,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconCircleWarningOutlineDuo18 as CircleWarning,
	IconCreditCardLockOutlineDuo18 as CreditCard,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconFileLockOutlineDuo18 as FileIcon,
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
import {
	formatStorageBytes,
	formatUsagePercentage,
	getAttachmentUsageSnapshot,
} from "@/lib/billing-attachment-usage";
import { m as messages } from "@bittery/i18n/paraglide/messages";
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
		meta: [{ title: messages.billing_page_meta_title() }],
	}),
});

const plans = [
	{
		id: "free" as const,
		nameKey: "billing_plan_free_name",
		descriptionKey: "billing_plan_free_description",
		featureKeys: [
			"billing_plan_free_feature_unlimited_passwords",
			"billing_plan_free_feature_one_vault",
			"billing_plan_free_feature_single_user",
			"billing_plan_free_feature_cross_platform_sync",
		],
		icon: User,
		memberLimit: planMemberLimits.free,
		highlighted: false,
	},
	{
		id: "personal" as const,
		nameKey: "billing_plan_personal_name",
		descriptionKey: "billing_plan_personal_description",
		featureKeys: [
			"billing_plan_personal_feature_everything_in_free",
			"billing_plan_personal_feature_sentinel_dashboard",
			"billing_plan_personal_feature_five_share_links",
			"billing_plan_personal_feature_file_attachments",
		],
		icon: StarSparkle,
		memberLimit: planMemberLimits.personal,
		highlighted: true,
	},
	{
		id: "family" as const,
		nameKey: "billing_plan_family_name",
		descriptionKey: "billing_plan_family_description",
		featureKeys: [
			"billing_plan_family_feature_everything_in_personal",
			"billing_plan_family_feature_up_to_six_members",
			"billing_plan_family_feature_five_shared_vaults",
			"billing_plan_family_feature_unlimited_share_links",
		],
		icon: Users,
		memberLimit: planMemberLimits.family,
		highlighted: false,
	},
	{
		id: "team" as const,
		nameKey: "billing_plan_team_name",
		descriptionKey: "billing_plan_team_description",
		featureKeys: [
			"billing_plan_team_feature_everything_in_family",
			"billing_plan_team_feature_unlimited_members",
			"billing_plan_team_feature_unlimited_shared_vaults",
			"billing_plan_team_feature_per_seat_billing",
		],
		icon: Shield,
		memberLimit: planMemberLimits.team,
		highlighted: false,
	},
] as const;

type PlanId = (typeof plans)[number]["id"];
const paidPlanIds = ["personal", "family", "team"] as const;

type BillingMessageCatalog = ReturnType<typeof useI18n>["m"];

function getPlanLabel(
	planId: CloudPlanId | string,
	m: BillingMessageCatalog,
): string {
	switch (planId) {
		case "free":
			return m.billing_plan_free_name();
		case "personal":
			return m.billing_plan_personal_name();
		case "family":
			return m.billing_plan_family_name();
		case "team":
			return m.billing_plan_team_name();
		default:
			return planId;
	}
}

function getStatusDisplay(status: string, m: BillingMessageCatalog) {
	switch (status) {
		case "active":
			return {
				label: m.billing_status_active(),
				variant: "default" as const,
			};
		case "trialing":
			return {
				label: m.billing_status_trialing(),
				variant: "secondary" as const,
			};
		case "past_due":
			return {
				label: m.billing_status_past_due(),
				variant: "destructive" as const,
			};
		case "canceled":
			return {
				label: m.billing_status_canceled(),
				variant: "outline" as const,
			};
		case "unpaid":
			return {
				label: m.billing_status_unpaid(),
				variant: "destructive" as const,
			};
		case "incomplete":
			return {
				label: m.billing_status_incomplete(),
				variant: "outline" as const,
			};
		default:
			return { label: m.billing_status_none(), variant: "outline" as const };
	}
}

function getMemberLimitLabel(
	memberLimit: number | null,
	m: BillingMessageCatalog,
): string {
	if (memberLimit === null) {
		return m.billing_plan_member_limit_unlimited();
	}

	return memberLimit === 1
		? m.billing_plan_member_limit_single({ count: memberLimit })
		: m.billing_plan_member_limit_plural({ count: memberLimit });
}

function getSeatsLabel(
	seatsPurchased: number,
	m: BillingMessageCatalog,
): string {
	return seatsPurchased === 1
		? m.billing_subscription_seats_single({ count: seatsPurchased })
		: m.billing_subscription_seats_plural({ count: seatsPurchased });
}

function getShareLinksLimitLabel(
	limit: number,
	m: BillingMessageCatalog,
): string {
	const countLabel = limit === 0 ? m.billing_limits_none() : String(limit);
	const label =
		limit === 1
			? m.billing_limits_share_links_single()
			: m.billing_limits_share_links_plural();
	return `${countLabel} ${label}`;
}

function getSharedVaultsLimitLabel(
	limit: number,
	m: BillingMessageCatalog,
): string {
	const countLabel = limit === 0 ? m.billing_limits_none() : String(limit);
	const label =
		limit === 1
			? m.billing_limits_shared_vaults_single()
			: m.billing_limits_shared_vaults_plural();
	return `${countLabel} ${label}`;
}

function formatEntitlementLabel(key: string, m: BillingMessageCatalog): string {
	switch (key) {
		case "sentinel":
			return m.billing_entitlement_sentinel();
		case "team_management":
			return m.billing_entitlement_team_management();
		case "vault_sharing":
			return m.billing_entitlement_vault_sharing();
		case "share_links":
			return m.billing_entitlement_share_links();
		case "billing_portal":
			return m.billing_entitlement_billing_portal();
		case "attachments":
			return m.billing_entitlement_attachments();
		default:
			return key;
	}
}

function BillingRoute() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const { checkout } = Route.useSearch();
	const { locale, m } = useI18n();

	const billingQuery = useQuery(trpc.billing.status.queryOptions());
	const entitlementsQuery = useQuery(trpc.billing.entitlements.queryOptions());
	const attachmentUsageQuery = useQuery(
		trpc.billing.attachmentUsage.queryOptions(),
	);

	const checkoutMutation = useMutation({
		mutationFn: (plan: (typeof paidPlanIds)[number]) =>
			trpcClient.billing.createCheckoutSession.mutate({ plan }),
		onSuccess: (result) => {
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			toast.error(m.billing_toast_checkout_url_missing());
		},
		onError: () => {
			toast.error(m.billing_toast_checkout_start_failed());
		},
	});

	const portalMutation = useMutation({
		mutationFn: () => trpcClient.billing.createPortalSession.mutate(),
		onSuccess: (result) => {
			window.location.href = result.url;
		},
		onError: () => {
			toast.error(m.billing_toast_portal_open_failed());
		},
	});

	useEffect(() => {
		if (checkout !== "success") return;
		queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
		queryClient.invalidateQueries({
			queryKey: trpc.billing.entitlements.queryKey(),
		});
		queryClient.invalidateQueries({
			queryKey: trpc.billing.attachmentUsage.queryKey(),
		});
		toast.success(m.billing_toast_checkout_refreshing());
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
					<p className="mt-3 font-medium">
						{m.billing_error_load_status_title()}
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{m.billing_error_load_status_description()}
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-4"
						onClick={() => billingQuery.refetch()}
					>
						{m.billing_error_load_status_retry()}
					</Button>
				</div>
			</div>
		);
	}

	const billing = billingQuery.data;
	const statusDisplay = getStatusDisplay(billing.status, m);
	const isPending = checkoutMutation.isPending || portalMutation.isPending;
	const attachmentUsage = attachmentUsageQuery.data
		? getAttachmentUsageSnapshot({
				attachmentsEnabled: attachmentUsageQuery.data.attachmentsEnabled,
				committedStorageBytes: attachmentUsageQuery.data.committedStorageBytes,
				quotaBytes: attachmentUsageQuery.data.quotaBytes,
			})
		: null;

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
						{m.billing_plan_current()}
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
					{m.billing_plan_current()}
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
					{m.billing_plan_complete_checkout()}
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
				{isUpgrade ? m.billing_plan_upgrade() : m.billing_plan_switch()}
			</Button>
		);
	};

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />

				<div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted shadow-sm sm:h-10 sm:w-10">
							<CreditCard className="h-4 w-4 text-muted-foreground sm:h-5 sm:w-5" />
						</div>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-1.5">
								<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
									{m.billing_page_heading()}
								</h1>
								<Badge
									variant={statusDisplay.variant}
									className="px-1.5 py-0 text-[11px]"
								>
									{statusDisplay.label}
								</Badge>
							</div>
							<p className="text-muted-foreground text-xs">
								{getPlanLabel(billing.plan, m)}
								{billing.cancelAtPeriodEnd && billing.currentPeriodEnd && (
									<>
										{" · "}
										<span className="text-amber-600 dark:text-amber-400">
											{m.billing_page_cancels({
												date: formatDate(billing.currentPeriodEnd),
											})}
										</span>
									</>
								)}
							</p>
						</div>
					</div>

					{billing.stripeCustomerId && (
						<div className="sm:shrink-0">
							<Button
								variant="outline"
								size="sm"
								className="h-8 px-2 sm:px-3"
								onClick={() => portalMutation.mutate()}
								disabled={isPending}
							>
								<ExternalLink className="mr-1.5 h-3.5 w-3.5" />
								<span className="text-xs">
									{m.billing_page_manage_stripe()}
								</span>
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
							{m.billing_alert_subscription_required_title()}
						</p>
						<p className="text-xs opacity-80">
							{m.billing_alert_subscription_required_description()}
						</p>
					</div>
				</div>
			)}

			{checkout === "success" && (
				<div className="flex items-start gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
					<div className="space-y-1">
						<p className="font-medium text-sm">
							{m.billing_alert_checkout_completed_title()}
						</p>
						<p className="text-xs opacity-80">
							{m.billing_alert_checkout_completed_description()}
						</p>
					</div>
				</div>
			)}

			{checkout === "cancel" && (
				<div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
					<CircleWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="space-y-1">
						<p className="font-medium text-sm">
							{m.billing_alert_checkout_canceled_title()}
						</p>
						<p className="text-muted-foreground text-xs">
							{m.billing_alert_checkout_canceled_description()}
						</p>
					</div>
				</div>
			)}

			{/* Plan Cards */}
			<div>
				<div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
					<h2 className="font-semibold text-lg tracking-tight">
						{m.billing_plans_title()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.billing_plans_description()}
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
											{m.billing_plan_popular()}
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
							{m.billing_subscription_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_subscription_description()}
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
										{m.billing_subscription_status()}
									</p>
									<div className="mt-0.5 flex items-center gap-2">
										<Badge variant={statusDisplay.variant}>
											{statusDisplay.label}
										</Badge>
										{billing.cancelAtPeriodEnd && (
											<span className="text-amber-600 text-xs dark:text-amber-400">
												{m.billing_subscription_canceling()}
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
												? m.billing_subscription_access_until()
												: m.billing_subscription_next_billing_date()}
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
											{m.billing_subscription_seats_purchased()}
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

			{/* Attachment Storage */}
			{attachmentUsage && (
				<section className="space-y-4">
					<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
						<h2 className="font-semibold text-lg tracking-tight">
							{m.billing_attachments_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_attachments_description()}
						</p>
					</div>

					<div className="rounded-xl border bg-card p-5">
						<div className="flex items-start gap-3">
							<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
								<FileIcon className="h-4 w-4 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1 space-y-1">
								<p className="font-medium text-sm">
									{m.billing_entitlement_attachments()}
								</p>
								<p className="text-muted-foreground text-xs">
									{attachmentUsage.state === "available"
										? m.billing_attachments_state_available()
										: m.billing_attachments_state_unavailable()}
								</p>
							</div>
						</div>

						{attachmentUsage.state === "available" && (
							<div
								className="mt-4 grid gap-4 sm:grid-cols-3"
							>
								<div className="rounded-lg bg-muted/40 p-4">
									<p className="text-muted-foreground text-xs">
										{m.billing_attachments_current_used()}
									</p>
									<p className="mt-1 font-semibold text-lg tracking-tight">
										{formatStorageBytes(
											attachmentUsage.committedStorageBytes,
											locale,
										)}
									</p>
								</div>
								<div className="rounded-lg bg-muted/40 p-4">
									<p className="text-muted-foreground text-xs">
										{m.billing_attachments_total_quota()}
									</p>
									<p className="mt-1 font-semibold text-lg tracking-tight">
										{attachmentUsage.quotaBytes === null
											? ""
											: formatStorageBytes(attachmentUsage.quotaBytes, locale)}
									</p>
								</div>
								{attachmentUsage.usedPercentage !== null && (
									<div className="rounded-lg bg-muted/40 p-4">
										<p className="text-muted-foreground text-xs">
											{m.billing_attachments_percentage_used()}
										</p>
										<p className="mt-1 font-semibold text-lg tracking-tight">
											{formatUsagePercentage(
												attachmentUsage.usedPercentage,
												locale,
											)}
										</p>
									</div>
								)}
							</div>
						)}

						{attachmentUsage.state === "available" &&
							attachmentUsage.progressPercentage !== null &&
							attachmentUsage.quotaBytes !== null && (
								<>
									<Progress
										value={attachmentUsage.progressPercentage}
										className="mt-4 h-2"
									/>
									<p className="mt-2 text-muted-foreground text-xs">
										{m.billing_attachments_progress({
											usedStorage: formatStorageBytes(
												attachmentUsage.committedStorageBytes,
												locale,
											),
											totalQuota: formatStorageBytes(
												attachmentUsage.quotaBytes,
												locale,
											),
										})}
									</p>
								</>
							)}
					</div>
				</section>
			)}

			{/* Entitlements */}
			{entitlementsQuery.data && (
				<section className="space-y-4">
					<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
						<h2 className="font-semibold text-lg tracking-tight">
							{m.billing_features_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_features_description()}
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
											className={
												enabled ? "" : "text-muted-foreground line-through"
											}
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
										entitlementsQuery.data.limits.shared_vaults !==
											undefined && (
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
