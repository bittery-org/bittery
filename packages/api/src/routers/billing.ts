import { db, team } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	isBillingActive,
	resolveEffectiveEntitlementLimits,
	resolveEffectiveEntitlements,
} from "../billing/entitlements";
import { type CloudPlanId } from "../billing/plans";
import {
	createStripeBillingPortalSession,
	createStripeCheckoutSession,
	ensureTeamStripeCustomer,
	isStripeApiConfigured,
	previewUpcomingTeamSeatInvoice,
	syncTeamSeatQuantity,
} from "../billing/stripe";
import { getStripePriceId, getWebAppUrl } from "../config/billing";
import { getBitteryMode, isSelfHostedMode } from "../config/mode";
import { protectedProcedure, router } from "../index";

const checkoutPlanSchema = z.enum(["personal", "family", "team"]);

function assertCloudBillingEnabled() {
	if (isSelfHostedMode()) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Billing is disabled in self-hosted mode",
		});
	}

	if (!isStripeApiConfigured()) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Stripe is not configured",
		});
	}
}

async function getBillingActor(userId: string) {
	const userData = await db.query.user.findFirst({
		where: (u, { eq: eqFn }) => eqFn(u.id, userId),
		with: {
			team: true,
		},
	});

	if (!userData || !userData.team || !userData.teamId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Team not found",
		});
	}

	const ensuredTeam = userData.team;
	const ensuredTeamId = userData.teamId;

	return {
		...userData,
		team: ensuredTeam,
		teamId: ensuredTeamId,
	};
}

function ensureBillingAdmin(role: string) {
	if (!["owner", "admin"].includes(role)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only team owner or admin can manage billing",
		});
	}
}

function isPaidPlan(plan: CloudPlanId): plan is Exclude<CloudPlanId, "free"> {
	return plan !== "free";
}

export const billingRouter = router({
	status: protectedProcedure.query(async ({ ctx }) => {
		if (isSelfHostedMode()) {
			return {
				enabled: false,
				plan: "free" as CloudPlanId,
				status: "none" as const,
				isActive: false,
				requiresPayment: false,
				isStripeConfigured: false,
				stripeCustomerId: null as string | null,
				stripeSubscriptionId: null as string | null,
				stripePriceId: null as string | null,
				currentPeriodEnd: null as Date | null,
				cancelAtPeriodEnd: false,
				seatsPurchased: null as number | null,
			};
		}

		const actor = await getBillingActor(ctx.session.userId);
		const requiresPayment = actor.team.billingPlan !== "free";

		return {
			enabled: true,
			plan: actor.team.billingPlan,
			status: actor.team.billingStatus,
			isActive: isBillingActive(actor.team.billingStatus),
			requiresPayment,
			isStripeConfigured: isStripeApiConfigured(),
			stripeCustomerId: actor.team.stripeCustomerId,
			stripeSubscriptionId: actor.team.stripeSubscriptionId,
			stripePriceId: actor.team.stripePriceId,
			currentPeriodEnd: actor.team.currentPeriodEnd,
			cancelAtPeriodEnd: actor.team.cancelAtPeriodEnd,
			seatsPurchased: actor.team.seatsPurchased,
		};
	}),

	entitlements: protectedProcedure.query(async ({ ctx }) => {
		const mode = getBitteryMode();
		const actor = await getBillingActor(ctx.session.userId);
		const entitlements = resolveEffectiveEntitlements({
			mode,
			billingPlan: actor.team.billingPlan,
			billingStatus: actor.team.billingStatus,
		});
		const limits = resolveEffectiveEntitlementLimits(
			{
				mode,
				billingPlan: actor.team.billingPlan,
				billingStatus: actor.team.billingStatus,
			},
			entitlements,
		);

		return {
			mode,
			plan: actor.team.billingPlan,
			status: actor.team.billingStatus,
			isActive: isBillingActive(actor.team.billingStatus),
			entitlements,
			limits,
		};
	}),

	createCheckoutSession: protectedProcedure
		.input(
			z.object({
				plan: checkoutPlanSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertCloudBillingEnabled();

			const actor = await getBillingActor(ctx.session.userId);
			ensureBillingAdmin(actor.role);

			const targetPlan = input.plan || actor.team.billingPlan;
			if (!isPaidPlan(targetPlan)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Free plan does not require checkout",
				});
			}

			if (
				actor.team.stripeSubscriptionId &&
				isBillingActive(actor.team.billingStatus) &&
				actor.team.billingPlan === targetPlan
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Subscription is already active for this plan",
				});
			}

			const stripePriceId = getStripePriceId(targetPlan);
			if (!stripePriceId) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Missing Stripe price ID for ${targetPlan} plan`,
				});
			}

			const teamMembers = await db.query.user.findMany({
				where: (u, { eq: eqFn }) => eqFn(u.teamId, actor.team.id),
				columns: { id: true },
			});
			const quantity = targetPlan === "team" ? Math.max(1, teamMembers.length) : 1;

			const customerId = await ensureTeamStripeCustomer({
				teamId: actor.team.id,
				userId: ctx.session.userId,
			});

			const baseUrl = getWebAppUrl().replace(/\/$/, "");
			const checkout = await createStripeCheckoutSession({
				teamId: actor.team.id,
				userId: ctx.session.userId,
				customerId,
				customerEmail: actor.email,
				plan: targetPlan,
				priceId: stripePriceId,
				quantity,
				successUrl: `${baseUrl}/billing?checkout=success`,
				cancelUrl: `${baseUrl}/billing?checkout=cancel`,
			});

			if (!checkout.url) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Stripe checkout session has no redirect URL",
				});
			}

			await db
				.update(team)
				.set({
					billingPlan: targetPlan,
					billingStatus: "incomplete",
					updatedAt: new Date(),
				})
				.where(eq(team.id, actor.team.id));

			return {
				url: checkout.url,
				sessionId: checkout.id,
			};
		}),

	createPortalSession: protectedProcedure.mutation(async ({ ctx }) => {
		assertCloudBillingEnabled();

		const actor = await getBillingActor(ctx.session.userId);
		ensureBillingAdmin(actor.role);
		const entitlements = resolveEffectiveEntitlements({
			mode: getBitteryMode(),
			billingPlan: actor.team.billingPlan,
			billingStatus: actor.team.billingStatus,
		});
		if (!entitlements.billing_portal) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Billing portal is unavailable for your current plan",
			});
		}

		if (!actor.team.stripeCustomerId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No Stripe customer found for this team",
			});
		}

		const baseUrl = getWebAppUrl().replace(/\/$/, "");
		const portal = await createStripeBillingPortalSession({
			customerId: actor.team.stripeCustomerId,
			returnUrl: `${baseUrl}/billing`,
		});

		return {
			url: portal.url,
		};
	}),

	syncSeats: protectedProcedure
		.input(
			z.object({
				teamId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertCloudBillingEnabled();

			const actor = await getBillingActor(ctx.session.userId);
			ensureBillingAdmin(actor.role);

			const targetTeamId = input.teamId || actor.team.id;
			if (targetTeamId !== actor.team.id) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You can only sync seats for your own team",
				});
			}

			const result = await syncTeamSeatQuantity(targetTeamId);
			return result;
		}),

	previewAdditionalTeamSeat: protectedProcedure.query(async ({ ctx }) => {
		assertCloudBillingEnabled();

		const actor = await getBillingActor(ctx.session.userId);
		ensureBillingAdmin(actor.role);

		try {
			return await previewUpcomingTeamSeatInvoice({
				teamId: actor.team.id,
				seatIncrement: 1,
			});
		} catch (error) {
			console.error("Failed to preview upcoming team seat invoice:", error);
			return null;
		}
	}),
});
