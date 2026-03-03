import { afterEach, describe, expect, test } from "bun:test";
import { billingRouter } from "../routers/billing";
import {
	createPublicContext,
	createTestTeam,
	setup,
	truncateAll,
} from "./test-utils";

const originalBitteryMode = process.env.BITTERY_MODE;
const originalStripeSecret = process.env.STRIPE_SECRET_KEY;

describe("Billing Router", () => {
	afterEach(async () => {
		await truncateAll();
		if (originalBitteryMode === undefined) {
			delete process.env.BITTERY_MODE;
		} else {
			process.env.BITTERY_MODE = originalBitteryMode;
		}

		if (originalStripeSecret === undefined) {
			delete process.env.STRIPE_SECRET_KEY;
		} else {
			process.env.STRIPE_SECRET_KEY = originalStripeSecret;
		}
	});

	test("status should return cloud billing snapshot", async () => {
		delete process.env.BITTERY_MODE;
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "personal",
			billingStatus: "incomplete",
			memberLimit: 1,
			type: "personal",
		});

		const result = await caller.status();

		expect(result.enabled).toBe(true);
		expect(result.plan).toBe("personal");
		expect(result.status).toBe("incomplete");
		expect(result.requiresPayment).toBe(true);
		expect(result.isActive).toBe(false);
	});

	test("status should disable billing in self-hosted mode", async () => {
		process.env.BITTERY_MODE = "self-hosted";
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "free",
			billingStatus: "none",
			type: "organization",
		});

		const result = await caller.status();

		expect(result.enabled).toBe(false);
		expect(result.plan).toBe("free");
	});

	test("entitlements should disable sentinel for free cloud plan", async () => {
		delete process.env.BITTERY_MODE;
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "free",
			billingStatus: "none",
			type: "personal",
		});

		const result = await caller.entitlements();

		expect(result.mode).toBe("cloud");
		expect(result.entitlements.sentinel).toBe(false);
		expect(result.entitlements.share_links).toBe(false);
		expect(result.entitlements.team_management).toBe(false);
		expect(result.entitlements.vault_sharing).toBe(false);
		expect(result.entitlements.attachments).toBe(false);
		expect(result.limits.share_links).toBe(0);
		expect(result.limits.shared_vaults).toBe(0);
	});

	test("entitlements should redirect paid inactive plan to limited access", async () => {
		delete process.env.BITTERY_MODE;
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "personal",
			billingStatus: "incomplete",
			type: "personal",
		});

		const result = await caller.entitlements();

		expect(result.isActive).toBe(false);
		expect(result.entitlements.sentinel).toBe(false);
		expect(result.entitlements.share_links).toBe(false);
		expect(result.entitlements.billing_portal).toBe(true);
		expect(result.limits.share_links).toBe(0);
		expect(result.limits.shared_vaults).toBe(0);
	});

	test("entitlements should disable cloud-only features in self-hosted mode", async () => {
		process.env.BITTERY_MODE = "self-hosted";
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "team",
			billingStatus: "active",
			type: "organization",
		});

		const result = await caller.entitlements();

		expect(result.mode).toBe("self-hosted");
		expect(result.entitlements.sentinel).toBe(false);
		expect(result.entitlements.billing_portal).toBe(false);
		expect(result.entitlements.share_links).toBe(true);
		expect(result.entitlements.team_management).toBe(true);
		expect(result.limits.share_links).toBeNull();
		expect(result.limits.shared_vaults).toBeNull();
	});

	test("createCheckoutSession should reject when Stripe is not configured", async () => {
		delete process.env.BITTERY_MODE;
		delete process.env.STRIPE_SECRET_KEY;
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "team",
			billingStatus: "incomplete",
			type: "organization",
		});

		await expect(
			caller.createCheckoutSession({ plan: "team" }),
		).rejects.toThrow("Stripe is not configured");
	});

	test("createCheckoutSession should be blocked in self-hosted mode", async () => {
		process.env.BITTERY_MODE = "self-hosted";
		const { caller, userId } = await setup(billingRouter);
		await createTestTeam(userId, {
			billingPlan: "team",
			billingStatus: "incomplete",
			type: "organization",
		});

		await expect(
			caller.createCheckoutSession({ plan: "team" }),
		).rejects.toThrow("Billing is disabled in self-hosted mode");
	});

	test("status should reject when user has no team", async () => {
		const caller = billingRouter.createCaller(createPublicContext());
		await expect(caller.status()).rejects.toThrow("Authentication required");
	});
});
