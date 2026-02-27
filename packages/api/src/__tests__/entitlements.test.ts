import { describe, expect, test } from "bun:test";
import {
	resolveEffectiveEntitlementLimits,
	resolveEffectiveEntitlements,
} from "../billing/entitlements";

describe("Billing entitlements resolver", () => {
	test("cloud free plan should not include sentinel", () => {
		const entitlements = resolveEffectiveEntitlements({
			mode: "cloud",
			billingPlan: "free",
			billingStatus: "none",
		});

		expect(entitlements.sentinel).toBe(false);
		expect(entitlements.team_management).toBe(false);
		expect(entitlements.vault_sharing).toBe(false);
		expect(entitlements.share_links).toBe(false);
		expect(entitlements.attachments).toBe(false);
		expect(entitlements.billing_portal).toBe(false);
		const limits = resolveEffectiveEntitlementLimits({
			mode: "cloud",
			billingPlan: "free",
			billingStatus: "none",
		});
		expect(limits.share_links).toBe(0);
		expect(limits.shared_vaults).toBe(0);
	});

	test("cloud paid active plan should include sentinel", () => {
		const entitlements = resolveEffectiveEntitlements({
			mode: "cloud",
			billingPlan: "personal",
			billingStatus: "active",
		});

		expect(entitlements.sentinel).toBe(true);
		expect(entitlements.team_management).toBe(false);
		expect(entitlements.vault_sharing).toBe(false);
		expect(entitlements.share_links).toBe(true);
		expect(entitlements.attachments).toBe(true);
		expect(entitlements.billing_portal).toBe(true);
		const limits = resolveEffectiveEntitlementLimits({
			mode: "cloud",
			billingPlan: "personal",
			billingStatus: "active",
		});
		expect(limits.share_links).toBe(5);
		expect(limits.shared_vaults).toBe(0);
	});

	test("cloud paid inactive plan should disable sentinel", () => {
		const entitlements = resolveEffectiveEntitlements({
			mode: "cloud",
			billingPlan: "team",
			billingStatus: "past_due",
		});

		expect(entitlements.sentinel).toBe(false);
		expect(entitlements.team_management).toBe(false);
		expect(entitlements.vault_sharing).toBe(false);
		expect(entitlements.share_links).toBe(false);
		expect(entitlements.attachments).toBe(false);
		expect(entitlements.billing_portal).toBe(true);
		const limits = resolveEffectiveEntitlementLimits({
			mode: "cloud",
			billingPlan: "team",
			billingStatus: "past_due",
		});
		expect(limits.share_links).toBe(0);
		expect(limits.shared_vaults).toBe(0);
	});

	test("self-hosted should disable cloud-only entitlements", () => {
		const entitlements = resolveEffectiveEntitlements({
			mode: "self-hosted",
			billingPlan: "team",
			billingStatus: "active",
		});

		expect(entitlements.sentinel).toBe(false);
		expect(entitlements.billing_portal).toBe(false);
		expect(entitlements.team_management).toBe(true);
		expect(entitlements.vault_sharing).toBe(true);
		expect(entitlements.share_links).toBe(true);
		expect(entitlements.attachments).toBe(true);
		const limits = resolveEffectiveEntitlementLimits({
			mode: "self-hosted",
			billingPlan: "team",
			billingStatus: "active",
		});
		expect(limits.share_links).toBeNull();
		expect(limits.shared_vaults).toBeNull();
	});

	test("family plan should include shared vault limit from pricing", () => {
		const limits = resolveEffectiveEntitlementLimits({
			mode: "cloud",
			billingPlan: "family",
			billingStatus: "active",
		});
		expect(limits.shared_vaults).toBe(5);
	});
});
