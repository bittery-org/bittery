import { describe, expect, test } from "bun:test";
import {
	isOneTimeShareLink,
	type ResolveShareAccessStageInput,
	resolveShareAccessStage,
	type ShareLinkPublicInfo,
} from "./share-access-gate";

const validAnyoneLink: ShareLinkPublicInfo = {
	valid: true,
	reason: null,
	accessMode: "anyone",
	isOneTimeUse: false,
	expiresAt: "2026-08-30T12:00:00Z",
};

const validOneTimeLink: ShareLinkPublicInfo = {
	...validAnyoneLink,
	isOneTimeUse: true,
};

function resolve(overrides: Partial<ResolveShareAccessStageInput> = {}) {
	return resolveShareAccessStage({
		linkInfoStatus: "ready",
		linkInfo: validAnyoneLink,
		hasShareKey: true,
		revealPending: false,
		hasDecryptedItem: false,
		hasFailure: false,
		...overrides,
	});
}

describe("Share access gate", () => {
	test("waits for an explicit reveal on a one-time link instead of consuming on load", () => {
		expect(resolve({ linkInfo: validOneTimeLink })).toBe("gate");
	});

	test("also gates ordinary multi-access links so prefetch cannot inflate access_count", () => {
		expect(resolve()).toBe("gate");
	});

	test("gates a link with no explicit one-time flag", () => {
		expect(
			resolve({ linkInfo: { ...validAnyoneLink, isOneTimeUse: null } }),
		).toBe("gate");
	});

	test("shows the spinner only while the confirmed access is in flight", () => {
		expect(resolve({ revealPending: true })).toBe("revealing");
	});

	test("shows the item once it is decrypted", () => {
		expect(resolve({ hasDecryptedItem: true })).toBe("revealed");
	});

	test("keeps showing the item after a later refetch failure", () => {
		expect(resolve({ hasDecryptedItem: true, hasFailure: true })).toBe(
			"revealed",
		);
	});

	test("surfaces the decryption failure path", () => {
		expect(resolve({ hasFailure: true })).toBe("failed");
	});
});

describe("Share access gate — unusable links never reach a consuming screen", () => {
	test("reports a missing fragment key before any reveal is possible", () => {
		expect(resolve({ hasShareKey: false })).toBe("missing-key");
	});

	test("reports a missing fragment key on email-restricted links too", () => {
		expect(
			resolve({
				hasShareKey: false,
				linkInfo: { ...validOneTimeLink, accessMode: "email-restricted" },
			}),
		).toBe("missing-key");
	});

	test.each([
		"expired",
		"revoked",
		"exhausted",
		"disabled",
	])("renders the unavailable card for a %s link", (reason) => {
		expect(
			resolve({
				linkInfo: {
					valid: false,
					reason,
					accessMode: "anyone",
					isOneTimeUse: null,
					expiresAt: null,
				},
			}),
		).toBe("link-unavailable");
	});

	test("an unavailable link wins over a missing key", () => {
		expect(
			resolve({
				hasShareKey: false,
				linkInfo: { valid: false, reason: "exhausted", accessMode: "anyone" },
			}),
		).toBe("link-unavailable");
	});

	test("renders the loading card while getPublicInfo is in flight", () => {
		expect(resolve({ linkInfoStatus: "loading", linkInfo: null })).toBe(
			"loading",
		);
	});

	test("renders the not-found card when getPublicInfo fails", () => {
		expect(resolve({ linkInfoStatus: "error", linkInfo: null })).toBe(
			"link-not-found",
		);
	});

	test("renders the not-found card when getPublicInfo returns nothing", () => {
		expect(resolve({ linkInfo: undefined })).toBe("link-not-found");
	});
});

describe("Share access gate — email-restricted mode", () => {
	test("routes to the code-entry form, which is itself the explicit gate", () => {
		expect(
			resolve({
				linkInfo: { ...validAnyoneLink, accessMode: "email-restricted" },
			}),
		).toBe("email-verification");
	});

	test("never falls through to the anyone-mode reveal button", () => {
		expect(
			resolve({
				linkInfo: { ...validOneTimeLink, accessMode: "email-restricted" },
				revealPending: true,
			}),
		).toBe("email-verification");
	});
});

describe("isOneTimeShareLink", () => {
	test("is true only for an explicit one-time flag", () => {
		expect(isOneTimeShareLink(validOneTimeLink)).toBe(true);
		expect(isOneTimeShareLink(validAnyoneLink)).toBe(false);
		expect(isOneTimeShareLink({ valid: true, isOneTimeUse: null })).toBe(false);
		expect(isOneTimeShareLink(null)).toBe(false);
		expect(isOneTimeShareLink(undefined)).toBe(false);
	});
});
