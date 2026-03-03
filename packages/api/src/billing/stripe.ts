import { createHash } from "node:crypto";
import { db, stripeEventLog, team } from "@bittery/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Stripe from "stripe";
import {
	getPlanByStripePriceId,
	getStripeSecretKey,
	getStripeWebhookSecret,
} from "../config/billing";
import type { CloudPlanId } from "./plans";

type BillingStatus =
	| "none"
	| "incomplete"
	| "trialing"
	| "active"
	| "past_due"
	| "canceled"
	| "unpaid";

const allowedPlanIds = new Set<CloudPlanId>([
	"free",
	"personal",
	"family",
	"team",
]);

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
	if (stripeClient) {
		return stripeClient;
	}

	const secretKey = getStripeSecretKey();
	if (!secretKey) {
		throw new Error("Stripe is not configured (missing STRIPE_SECRET_KEY)");
	}

	stripeClient = new Stripe(secretKey);
	return stripeClient;
}

function getEventPayloadHash(payload: string): string {
	return createHash("sha256").update(payload).digest("hex");
}

function toObjectId(value: string | { id?: string } | null | undefined): string | null {
	if (!value) return null;
	if (typeof value === "string") return value;
	if (typeof value.id === "string") return value.id;
	return null;
}

function parsePlanId(value: string | null | undefined): CloudPlanId | null {
	if (!value || !allowedPlanIds.has(value as CloudPlanId)) {
		return null;
	}
	return value as CloudPlanId;
}

function mapStripeStatus(status: string | null | undefined): BillingStatus {
	switch (status) {
		case "active":
			return "active";
		case "trialing":
			return "trialing";
		case "past_due":
			return "past_due";
		case "canceled":
			return "canceled";
		case "unpaid":
			return "unpaid";
		case "incomplete":
		case "incomplete_expired":
		default:
			return "incomplete";
	}
}

function getFirstSubscriptionItem(
	subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | null {
	return subscription.items.data[0] || null;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	return toObjectId(invoice.parent?.subscription_details?.subscription as any);
}

function isTeamPlan(plan: CloudPlanId | null | undefined): plan is "team" {
	return plan === "team";
}

async function findTeamForEvent(input: {
	teamId?: string | null;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
}) {
	if (input.teamId) {
		const direct = await db.query.team.findFirst({
			where: (t, { eq: eqFn }) => eqFn(t.id, input.teamId!),
		});
		if (direct) return direct;
	}

	if (input.stripeSubscriptionId) {
		const bySubscription = await db.query.team.findFirst({
			where: (t, { eq: eqFn }) =>
				eqFn(t.stripeSubscriptionId, input.stripeSubscriptionId!),
		});
		if (bySubscription) return bySubscription;
	}

	if (input.stripeCustomerId) {
		return db.query.team.findFirst({
			where: (t, { eq: eqFn }) =>
				eqFn(t.stripeCustomerId, input.stripeCustomerId!),
		});
	}

	return null;
}

async function applyCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
	const teamId =
		session.metadata?.teamId ||
		(typeof session.client_reference_id === "string"
			? session.client_reference_id
			: null);
	const plan = parsePlanId(session.metadata?.plan);

	const teamData = await findTeamForEvent({
		teamId,
		stripeCustomerId: toObjectId(session.customer as any),
		stripeSubscriptionId: toObjectId(session.subscription as any),
	});

	if (!teamData) return;

	await db
		.update(team)
		.set({
			...(plan ? { billingPlan: plan } : {}),
			...(session.customer
				? { stripeCustomerId: toObjectId(session.customer as any) }
				: {}),
			...(session.subscription
				? {
						stripeSubscriptionId: toObjectId(session.subscription as any),
				  }
				: {}),
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamData.id));
}

async function applySubscriptionUpdate(
	subscription: Stripe.Subscription,
	kind: "created" | "updated" | "deleted",
) {
	const firstItem = getFirstSubscriptionItem(subscription);
	const stripePriceId = firstItem?.price?.id || null;

	const teamData = await findTeamForEvent({
		teamId: subscription.metadata?.teamId || null,
		stripeCustomerId: toObjectId(subscription.customer as any),
		stripeSubscriptionId: subscription.id,
	});

	if (!teamData) return;

	const planFromPrice = getPlanByStripePriceId(stripePriceId);
	const planFromMetadata = parsePlanId(subscription.metadata?.plan);
	const billingPlan = planFromMetadata || planFromPrice || teamData.billingPlan;
	const clearSubscription = kind === "deleted";

	await db
		.update(team)
		.set({
			billingPlan,
			billingStatus:
				kind === "deleted" ? "canceled" : mapStripeStatus(subscription.status),
			...(subscription.customer
				? {
						stripeCustomerId: toObjectId(subscription.customer as any),
				  }
				: {}),
			stripeSubscriptionId: clearSubscription ? null : subscription.id,
			stripeSubscriptionItemId: clearSubscription ? null : firstItem?.id || null,
			stripePriceId: clearSubscription ? null : stripePriceId,
			seatsPurchased:
				clearSubscription || !isTeamPlan(billingPlan)
					? null
					: firstItem?.quantity || null,
			currentPeriodEnd:
				clearSubscription || !firstItem?.current_period_end
					? null
					: new Date(firstItem.current_period_end * 1000),
			cancelAtPeriodEnd:
				kind === "deleted" ? false : !!subscription.cancel_at_period_end,
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamData.id));
}

async function applyInvoicePaid(invoice: Stripe.Invoice) {
	const teamData = await findTeamForEvent({
		stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
		stripeCustomerId: toObjectId(invoice.customer as any),
	});

	if (!teamData || teamData.billingPlan === "free") return;

	await db
		.update(team)
		.set({
			billingStatus: "active",
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamData.id));
}

async function applyInvoicePaymentFailed(invoice: Stripe.Invoice) {
	const teamData = await findTeamForEvent({
		stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
		stripeCustomerId: toObjectId(invoice.customer as any),
	});

	if (!teamData || teamData.billingPlan === "free") return;

	await db
		.update(team)
		.set({
			billingStatus: "past_due",
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamData.id));
}

export async function processStripeWebhookEvent(
	rawBody: string,
	event: Stripe.Event,
) {
	const payloadHash = getEventPayloadHash(rawBody);

	const result = await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(stripeEventLog)
			.values({
				id: nanoid(),
				eventId: event.id,
				eventType: event.type,
				payloadHash,
			})
			.onConflictDoNothing({ target: stripeEventLog.eventId })
			.returning({ id: stripeEventLog.id });

		if (inserted.length === 0) {
			return { duplicate: true };
		}

		return { duplicate: false };
	});

	if (result.duplicate) {
		return { duplicate: true };
	}

	switch (event.type) {
		case "checkout.session.completed":
			await applyCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
			break;
		case "customer.subscription.created":
			await applySubscriptionUpdate(event.data.object as Stripe.Subscription, "created");
			break;
		case "customer.subscription.updated":
			await applySubscriptionUpdate(event.data.object as Stripe.Subscription, "updated");
			break;
		case "customer.subscription.deleted":
			await applySubscriptionUpdate(event.data.object as Stripe.Subscription, "deleted");
			break;
		case "invoice.paid":
			await applyInvoicePaid(event.data.object as Stripe.Invoice);
			break;
		case "invoice.payment_failed":
			await applyInvoicePaymentFailed(event.data.object as Stripe.Invoice);
			break;
		default:
			break;
	}

	return { duplicate: false };
}

export async function createStripeCustomer(input: {
	teamId: string;
	userId: string;
	email: string;
	name: string;
}) {
	const stripe = getStripeClient();
	return stripe.customers.create({
		email: input.email,
		name: input.name,
		metadata: {
			teamId: input.teamId,
			initiatedByUserId: input.userId,
		},
	});
}

export async function createStripeCheckoutSession(input: {
	teamId: string;
	userId: string;
	customerId: string | null;
	customerEmail: string;
	plan: Exclude<CloudPlanId, "free">;
	priceId: string;
	quantity: number;
	successUrl: string;
	cancelUrl: string;
}) {
	const stripe = getStripeClient();
	return stripe.checkout.sessions.create({
		mode: "subscription",
		success_url: input.successUrl,
		cancel_url: input.cancelUrl,
		client_reference_id: input.teamId,
		allow_promotion_codes: true,
		line_items: [
			{
				price: input.priceId,
				quantity: Math.max(1, input.quantity),
			},
		],
		...(input.customerId
			? { customer: input.customerId }
			: { customer_email: input.customerEmail }),
		metadata: {
			teamId: input.teamId,
			plan: input.plan,
			initiatedByUserId: input.userId,
		},
		subscription_data: {
			metadata: {
				teamId: input.teamId,
				plan: input.plan,
				initiatedByUserId: input.userId,
			},
		},
	});
}

export async function createStripeBillingPortalSession(input: {
	customerId: string;
	returnUrl: string;
}) {
	const stripe = getStripeClient();
	return stripe.billingPortal.sessions.create({
		customer: input.customerId,
		return_url: input.returnUrl,
	});
}

export async function updateStripeSubscriptionItemQuantity(input: {
	subscriptionItemId: string;
	quantity: number;
}) {
	const stripe = getStripeClient();
	return stripe.subscriptionItems.update(input.subscriptionItemId, {
		quantity: Math.max(1, input.quantity),
		proration_behavior: "create_prorations",
	});
}

export async function ensureTeamStripeCustomer(input: {
	teamId: string;
	userId: string;
}) {
	const teamData = await db.query.team.findFirst({
		where: (t, { eq: eqFn }) => eqFn(t.id, input.teamId),
	});
	if (!teamData) {
		throw new Error("Team not found");
	}

	if (teamData.stripeCustomerId) {
		return teamData.stripeCustomerId;
	}

	const owner = await db.query.user.findFirst({
		where: (u, { and: andFn, eq: eqFn }) =>
			andFn(eqFn(u.id, teamData.ownerId), eqFn(u.teamId, teamData.id)),
	});

	const fallbackUser = await db.query.user.findFirst({
		where: (u, { and: andFn, eq: eqFn }) =>
			andFn(eqFn(u.id, input.userId), eqFn(u.teamId, teamData.id)),
	});

	const billingContact = owner || fallbackUser;
	if (!billingContact) {
		throw new Error("No billing contact found for team");
	}

	const created = await createStripeCustomer({
		teamId: teamData.id,
		userId: input.userId,
		email: billingContact.email,
		name: billingContact.name,
	});

	await db
		.update(team)
		.set({
			stripeCustomerId: created.id,
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamData.id));

	return created.id;
}

export async function syncTeamSeatQuantity(teamId: string) {
	const teamData = await db.query.team.findFirst({
		where: (t, { eq: eqFn }) => eqFn(t.id, teamId),
	});

	if (!teamData) {
		return { synced: false as const, reason: "team_not_found" };
	}

	if (teamData.billingPlan !== "team") {
		return { synced: false as const, reason: "not_team_plan" };
	}

	if (!teamData.stripeSubscriptionItemId) {
		return { synced: false as const, reason: "missing_subscription_item" };
	}

	const members = await db.query.user.findMany({
		where: (u, { eq: eqFn }) => eqFn(u.teamId, teamId),
		columns: { id: true },
	});

	const quantity = Math.max(1, members.length);
	await updateStripeSubscriptionItemQuantity({
		subscriptionItemId: teamData.stripeSubscriptionItemId,
		quantity,
	});

	await db
		.update(team)
		.set({
			seatsPurchased: quantity,
			updatedAt: new Date(),
		})
		.where(eq(team.id, teamId));

	return { synced: true as const, quantity };
}

export interface TeamSeatInvoicePreviewLine {
	id: string;
	description: string;
	amountCents: number;
	currency: string;
	periodStart: Date;
	periodEnd: Date;
	quantity: number | null;
	unitAmountCents: number | null;
	isProration: boolean;
}

export interface TeamSeatInvoicePreview {
	currency: string;
	currentQuantity: number;
	nextQuantity: number;
	estimatedNextPaymentCents: number;
	totalLineItemsCents: number;
	lines: TeamSeatInvoicePreviewLine[];
}

function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
	return (
		line.parent?.subscription_item_details?.proration === true ||
		line.parent?.invoice_item_details?.proration === true
	);
}

function getLineUnitAmountCents(line: Stripe.InvoiceLineItem): number | null {
	const amountDecimal = line.pricing?.unit_amount_decimal;
	if (typeof amountDecimal === "string") {
		const parsed = Number(amountDecimal);
		if (Number.isFinite(parsed)) {
			return Math.round(parsed);
		}
	}

	if (typeof line.quantity === "number" && line.quantity > 0) {
		return Math.round(line.amount / line.quantity);
	}

	return null;
}

export async function previewUpcomingTeamSeatInvoice(input: {
	teamId: string;
	seatIncrement?: number;
}): Promise<TeamSeatInvoicePreview | null> {
	const teamData = await db.query.team.findFirst({
		where: (t, { eq: eqFn }) => eqFn(t.id, input.teamId),
	});

	if (
		!teamData ||
		teamData.billingPlan !== "team" ||
		!teamData.stripeCustomerId ||
		!teamData.stripeSubscriptionId
	) {
		return null;
	}

	const stripe = getStripeClient();
	const subscription = await stripe.subscriptions.retrieve(
		teamData.stripeSubscriptionId,
		{
			expand: ["items.data.price"],
		},
	);

	const subscriptionItem =
		subscription.items.data.find(
			(item) => item.id === teamData.stripeSubscriptionItemId,
		) || subscription.items.data[0];
	if (!subscriptionItem) {
		return null;
	}

	const currentQuantity = Math.max(
		1,
		subscriptionItem.quantity ?? teamData.seatsPurchased ?? 1,
	);
	const seatIncrement = Math.max(1, input.seatIncrement ?? 1);
	const nextQuantity = currentQuantity + seatIncrement;

	const upcomingInvoice = await stripe.invoices.createPreview({
		customer: teamData.stripeCustomerId,
		subscription: teamData.stripeSubscriptionId,
		subscription_details: {
			items: [
				{
					id: subscriptionItem.id,
					quantity: nextQuantity,
				},
			],
		},
	});

	const fallbackCurrency = upcomingInvoice.currency || subscription.currency || "eur";

	const nonZeroLines = upcomingInvoice.lines.data.filter((line) => line.amount !== 0);
	const subscriptionScopedLines = nonZeroLines.filter((line) => {
		const subscriptionItemId =
			line.parent?.subscription_item_details?.subscription_item;
		const subscriptionId = line.parent?.invoice_item_details?.subscription;
		return (
			subscriptionItemId === subscriptionItem.id ||
			subscriptionId === teamData.stripeSubscriptionId
		);
	});
	const linesSource =
		subscriptionScopedLines.length > 0 ? subscriptionScopedLines : nonZeroLines;

	const lines = linesSource
		.filter((line) => line.amount !== 0)
		.map((line) => ({
			id: line.id,
			description: line.description || "Team",
			amountCents: line.amount,
			currency: line.currency || fallbackCurrency,
			periodStart: new Date(line.period.start * 1000),
			periodEnd: new Date(line.period.end * 1000),
			quantity: typeof line.quantity === "number" ? line.quantity : null,
			unitAmountCents: getLineUnitAmountCents(line),
			isProration: isProrationLine(line),
		}))
		.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());

	const totalLineItemsCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
	const estimatedNextPaymentCents =
		typeof upcomingInvoice.amount_due === "number"
			? upcomingInvoice.amount_due
			: typeof upcomingInvoice.total === "number"
				? upcomingInvoice.total
				: totalLineItemsCents;

	return {
		currency: fallbackCurrency,
		currentQuantity,
		nextQuantity,
		estimatedNextPaymentCents,
		totalLineItemsCents,
		lines,
	};
}

export async function parseStripeWebhookEvent(
	rawBody: string,
	signatureHeader: string | null,
): Promise<Stripe.Event> {
	const webhookSecret = getStripeWebhookSecret();
	if (!webhookSecret) {
		throw new Error("Stripe webhook is not configured (missing STRIPE_WEBHOOK_SECRET)");
	}

	if (!signatureHeader) {
		throw new Error("Missing Stripe signature header");
	}

	const stripe = getStripeClient();
	return stripe.webhooks.constructEventAsync(rawBody, signatureHeader, webhookSecret);
}

export function isStripeWebhookConfigured(): boolean {
	return !!(getStripeSecretKey() && getStripeWebhookSecret());
}

export function isStripeApiConfigured(): boolean {
	return !!getStripeSecretKey();
}
