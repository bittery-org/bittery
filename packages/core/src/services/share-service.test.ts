import { describe, expect, it } from "bun:test";
import { buildShareUrl, type CreateShareResult } from "./share-service";

function result(overrides: Partial<CreateShareResult> = {}): CreateShareResult {
	return {
		token: "tok_abc123",
		shareKeyBase64: "c2hhcmVLZXlCeXRlcw==",
		expiresAt: "2026-08-30T00:00:00.000Z",
		baseShareUrl: "https://bittery.test/share/",
		...overrides,
	};
}

describe("buildShareUrl", () => {
	it("puts the share key in the URL fragment", () => {
		expect(buildShareUrl(result())).toBe(
			"https://bittery.test/share/tok_abc123#c2hhcmVLZXlCeXRlcw==",
		);
	});

	// Regression guard: a share URL without its fragment is permanently
	// undecryptable for the recipient. Anything that hands a share link to a
	// user must go through buildShareUrl, never `baseShareUrl + token`.
	it("never produces a link whose fragment is missing or empty", () => {
		const url = buildShareUrl(result());
		const fragment = url.slice(url.indexOf("#") + 1);

		expect(url).toContain("#");
		expect(fragment).toBe("c2hhcmVLZXlCeXRlcw==");
		expect(fragment.length).toBeGreaterThan(0);
	});

	it("keeps the key out of the part of the URL the server receives", () => {
		const url = buildShareUrl(result());
		const beforeFragment = url.slice(0, url.indexOf("#"));

		expect(beforeFragment).not.toContain("c2hhcmVLZXlCeXRlcw==");
	});
});
