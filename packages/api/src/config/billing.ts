import { cloudPlanIds, type CloudPlanId } from "../billing/plans";

const stripeApiBaseUrl = "https://api.stripe.com/v1";

type PaidPlanId = Exclude<CloudPlanId, "free">;

const priceEnvByPlan: Record<PaidPlanId, string> = {
	personal: "STRIPE_PRICE_PERSONAL_MONTHLY",
	family: "STRIPE_PRICE_FAMILY_MONTHLY",
	team: "STRIPE_PRICE_TEAM_SEAT_MONTHLY",
};

export function getStripeSecretKey(): string | null {
	return process.env.STRIPE_SECRET_KEY?.trim() || null;
}

export function getStripeWebhookSecret(): string | null {
	return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

export function getStripeApiBaseUrl(): string {
	return stripeApiBaseUrl;
}

export function getStripePriceId(plan: PaidPlanId): string | null {
	const envName = priceEnvByPlan[plan];
	return process.env[envName]?.trim() || null;
}

export function getPlanByStripePriceId(priceId: string | null | undefined): CloudPlanId | null {
	if (!priceId) {
		return null;
	}

	for (const plan of cloudPlanIds) {
		if (plan === "free") continue;
		if (getStripePriceId(plan) === priceId) {
			return plan;
		}
	}

	return null;
}

export function getWebAppUrl(): string {
	return (
		process.env.WEB_APP_URL?.trim() ||
		process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
		"http://localhost:3001"
	);
}

export function assertStripeConfigured(): void {
	const secretKey = getStripeSecretKey();
	if (!secretKey) {
		throw new Error("Missing STRIPE_SECRET_KEY");
	}
}
