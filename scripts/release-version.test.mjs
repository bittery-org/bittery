import assert from "node:assert/strict";
import test from "node:test";
import {
	bumpVersion,
	compareVersions,
	latestVersionFromTags,
	parseVersion,
} from "./release-version.mjs";

test("compares stable versions numerically", () => {
	assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("1.2.2", "1.2.3"), -1);
});

test("rejects loose and prerelease versions", () => {
	for (const version of ["1.2", "01.2.3", "1.2.3-beta.1", "v1.2.3"]) {
		assert.throws(() => parseVersion(version), /Invalid version/);
	}
});

test("bumps each stable release component", () => {
	assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
	assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
	assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
});

test("finds the latest stable release and ignores other tags", () => {
	assert.equal(
		latestVersionFromTags(["v0.9.0", "v0.10.0", "v1.0.0-beta.1", "desktop-v2"]),
		"0.10.0",
	);
	assert.equal(latestVersionFromTags([]), null);
});
