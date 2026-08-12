import { describe, expect, test } from "bun:test";
import { shouldBuildE2eServerBinaries } from "./e2e-server-binaries";

describe("E2E server binary preparation", () => {
	test("builds before servers start in a normal primary Playwright process", () => {
		expect(shouldBuildE2eServerBinaries({})).toBe(true);
	});

	test("leaves the build to the explicit CI preparation step", () => {
		expect(
			shouldBuildE2eServerBinaries({ E2E_SERVER_BINARIES_READY: "1" }),
		).toBe(false);
	});

	test("does not repeat the build from a worker config import", () => {
		expect(shouldBuildE2eServerBinaries({ TEST_WORKER_INDEX: "0" })).toBe(
			false,
		);
	});
});
