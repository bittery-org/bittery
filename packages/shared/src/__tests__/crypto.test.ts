import { describe, expect, test } from "bun:test";
import { getRecoveryKeyHint, getSecretKeyHint } from "../crypto";

describe("formatted key hints", () => {
	test("keeps the prefix and the first segment of a Secret Key", () => {
		expect(getSecretKeyHint("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
			"A3-ABCDEF",
		);
	});

	test("keeps the prefix and the first segment of a Recovery Key", () => {
		expect(getRecoveryKeyHint("R1-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2-34567")).toBe(
			"R1-ABCDEF",
		);
	});

	test("is empty rather than partial when there is no segment to show", () => {
		expect(getSecretKeyHint("A3")).toBe("");
		expect(getRecoveryKeyHint("")).toBe("");
	});
});
