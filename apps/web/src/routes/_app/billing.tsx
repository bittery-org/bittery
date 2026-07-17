import { m as messages } from "@bittery/i18n/paraglide/messages";
import { type CloudPlanId, planMemberLimits } from "@bittery/shared/billing";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import {
	Badge,
	Button,
	Progress,
	Separator,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconCircleCheck as CheckCircle,
	IconCircleAlert as CircleWarning,
	IconCreditCard as CreditCard,
	IconExternalLink as ExternalLink,
	IconFileLock as FileIcon,
	IconShieldCheck as Shield,
	IconSparkles as StarSparkle,
	IconUser as User,
	IconUsers as Users,
} from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import {
	formatStorageBytes,
	formatUsagePercentage,
	getAttachmentUsageSnapshot,
} from "@/lib/billing-attachment-usage";
import { formatDate } from "@/lib/i18n-format";
import {
	normalizeCloudPlanId,
	normalizeEntitlementLimits,
} from "@/lib/rpc-normalizers";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/billing")({
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			context.rpc.billing.entitlements.queryOptions(),
		);

		if (access.mode !== "cloud") {
			throw redirect({ to: "/home" });
		}
		if (access.billingEnabled !== true) {
			throw redirect({ to: "/home" });
		}

		const me = await context.queryClient.ensureQueryData(
			context.rpc.auth.me.queryOptions(),
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
		case "teamManagement":
		case "team_management":
			return m.billing_entitlement_team_management();
		case "vaultSharing":
		case "vault_sharing":
			return m.billing_entitlement_vault_sharing();
		case "shareLinks":
		case "share_links":
			return m.billing_entitlement_share_links();
		case "billingPortal":
		case "billing_portal":
			return m.billing_entitlement_billing_portal();
		case "attachments":
			return m.billing_entitlement_attachments();
		default:
			return key;
	}
}

function BillingRoute() {
	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const queryClient = useQueryClient();
	const { checkout } = Route.useSearch();
	const { locale, m } = useI18n();

	const billingQuery = useQuery(rpc.billing.status.queryOptions());
	const entitlementsQuery = useQuery(rpc.billing.entitlements.queryOptions());
	const attachmentUsageQuery = useQuery(
		rpc.billing.attachmentUsage.queryOptions(),
	);

	const checkoutMutation = useMutation({
		mutationFn: (plan: (typeof paidPlanIds)[number]) =>
			rpcClient.billing.createCheckoutSession.mutate({ plan }),
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
		mutationFn: () => rpcClient.billing.createPortalSession.mutate(),
		onSuccess: (result) => {
			window.location.href = result.url;
		},
		onError: () => {
			toast.error(m.billing_toast_portal_open_failed());
		},
	});

	useEffect(() => {
		if (checkout !== "success") return;
		queryClient.invalidateQueries({ queryKey: rpc.billing.status.queryKey() });
		queryClient.invalidateQueries({
			queryKey: rpc.billing.entitlements.queryKey(),
		});
		queryClient.invalidateQueries({
			queryKey: rpc.billing.attachmentUsage.queryKey(),
		});
		toast.success(m.billing_toast_checkout_refreshing());
	}, [checkout, m, queryClient, rpc]);

	if (billingQuery.isLoading) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-6">
				<Skeleton className="h-48 w-full rounded-lg" />
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
				<div className="rounded-lg border bg-card p-4 text-center">
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
				committedStorageBytes: Number(
					attachmentUsageQuery.data.committedStorageBytes,
				),
				quotaBytes:
					attachmentUsageQuery.data.quotaBytes === null
						? null
						: Number(attachmentUsageQuery.data.quotaBytes),
			})
		: null;
	const entitlementLimits = normalizeEntitlementLimits(
		entitlementsQuery.data?.limits,
	);

	const getButtonForPlan = (planId: PlanId) => {
		const isCurrent = billing.plan === planId;
		const isActive = billing.isActive;

		if (planId === "free") {
			if (isCurrent) {
				return (
					<Badge
						variant="outline"
						className="border-success/30 bg-success/10 text-success"
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
					className="border-success/30 bg-success/10 text-success"
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
		const currentIndex = planOrder.indexOf(
			normalizeCloudPlanId(billing.plan) ?? "free",
		);
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
			{/* Hero Header */}
			<div className="flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
					<CreditCard className="size-4" aria-hidden />
				</div>
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-1.5">
						<h1 className="truncate font-semibold text-lg tracking-[-0.015em]">
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
								<span className="text-warning">
									{m.billing_page_cancels({
										date: formatDate(billing.currentPeriodEnd),
									})}
								</span>
							</>
						)}
					</p>
				</div>

				{billing.stripeCustomerId && (
					<div className="ml-auto shrink-0">
						<Button
							variant="outline"
							size="sm"
							className="h-8 px-2 sm:px-3"
							onClick={() => portalMutation.mutate()}
							disabled={isPending}
						>
							<ExternalLink className="mr-1.5 h-3.5 w-3.5" />
							<span className="text-xs">{m.billing_page_manage_stripe()}</span>
						</Button>
					</div>
				)}
			</div>

			{/* Checkout Alerts */}
			{billing.requiresPayment && !billing.isActive && (
				<div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning">
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
				<div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-3 text-success">
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
				<div className="flex items-start gap-3 rounded-lg border bg-card p-4">
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
					<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
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
								className={`relative flex flex-col rounded-lg border p-4 transition-colors ${
									isCurrent
										? "bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
										: "bg-card hover:border-border-strong"
								}`}
							>
								{plan.highlighted && !isCurrent && (
									<div className="absolute -top-2.5 right-4">
										<Badge className="text-[10.5px]">
											{m.billing_plan_popular()}
										</Badge>
									</div>
								)}

								<div className="mb-4 flex items-center gap-3">
									<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
										<Icon className="size-4" />
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
											<CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
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
						<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.billing_subscription_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_subscription_description()}
						</p>
					</div>

					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{/* Status */}
						<div className="rounded-lg border bg-card p-4">
							<div className="flex items-center gap-3">
								<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
									<CheckCircle className="size-4" />
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
											<span className="text-warning text-xs">
												{m.billing_subscription_canceling()}
											</span>
										)}
									</div>
								</div>
							</div>
						</div>

						{/* Billing Period */}
						{billing.currentPeriodEnd && (
							<div className="rounded-lg border bg-card p-4">
								<div className="flex items-center gap-3">
									<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
										<CreditCard className="size-4" />
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
							<div className="rounded-lg border bg-card p-4">
								<div className="flex items-center gap-3">
									<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
										<Users className="size-4" />
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
						<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.billing_attachments_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_attachments_description()}
						</p>
					</div>

					<div className="rounded-lg border bg-card p-4">
						<div className="flex items-start gap-3">
							<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
								<FileIcon className="size-4" />
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
							<div className="mt-4 grid gap-4 sm:grid-cols-3">
								<div className="rounded-md border bg-foreground/3 p-3">
									<p className="text-muted-foreground text-xs">
										{m.billing_attachments_current_used()}
									</p>
									<p className="mt-1 font-semibold text-xl tabular-nums">
										{formatStorageBytes(
											attachmentUsage.committedStorageBytes,
											locale,
										)}
									</p>
								</div>
								<div className="rounded-md border bg-foreground/3 p-3">
									<p className="text-muted-foreground text-xs">
										{m.billing_attachments_total_quota()}
									</p>
									<p className="mt-1 font-semibold text-xl tabular-nums">
										{attachmentUsage.quotaBytes === null
											? ""
											: formatStorageBytes(attachmentUsage.quotaBytes, locale)}
									</p>
								</div>
								{attachmentUsage.usedPercentage !== null && (
									<div className="rounded-md border bg-foreground/3 p-3">
										<p className="text-muted-foreground text-xs">
											{m.billing_attachments_percentage_used()}
										</p>
										<p className="mt-1 font-semibold text-xl tabular-nums">
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
						<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.billing_features_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.billing_features_description()}
						</p>
					</div>

					<div className="rounded-lg border bg-card p-4">
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{Object.entries(entitlementsQuery.data.entitlements).map(
								([key, enabled]) => (
									<div key={key} className="flex items-center gap-2.5 text-sm">
										{enabled ? (
											<CheckCircle className="h-4 w-4 shrink-0 text-success" />
										) : (
											<div className="h-4 w-4 shrink-0 rounded-full border border-border" />
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
									{entitlementLimits.shareLinks !== null && (
										<div className="text-muted-foreground text-xs">
											<span className="font-medium text-foreground">
												{getShareLinksLimitLabel(
													entitlementLimits.shareLinks,
													m,
												)}
											</span>
										</div>
									)}
									{entitlementLimits.sharedVaults !== null && (
										<div className="text-muted-foreground text-xs">
											<span className="font-medium text-foreground">
												{getSharedVaultsLimitLabel(
													entitlementLimits.sharedVaults,
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
