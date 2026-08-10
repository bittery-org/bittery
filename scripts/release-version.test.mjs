import assert from "node:assert/strict";
import test from "node:test";
import {
	bumpVersion,
	compareVersions,
	latestVersionFromTags,
	parseVersion,
	resolveVersion,
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

test("uses an explicit version argument over the repository version", () => {
	assert.equal(
		resolveVersion({
			args: ["9.9.9"],
			rootVersion: "0.4.1",
			latestReleasedVersion: "0.4.1",
		}),
		"9.9.9",
	);
	assert.equal(
		resolveVersion({
			args: ["--check", "9.9.9"],
			rootVersion: "0.4.1",
			latestReleasedVersion: "0.4.1",
		}),
		"9.9.9",
	);
});

test("falls back to the repository version with no arguments", () => {
	assert.equal(
		resolveVersion({
			args: ["--check", "--check-history"],
			rootVersion: "0.4.1",
			latestReleasedVersion: "0.4.1",
		}),
		"0.4.1",
	);
});

test("never bumps below the repository version when tagging lagged", () => {
	assert.equal(
		resolveVersion({
			args: ["--next", "patch"],
			rootVersion: "0.5.0",
			latestReleasedVersion: "0.4.1",
		}),
		"0.5.1",
	);
	assert.equal(
		resolveVersion({
			args: ["--next", "minor"],
			rootVersion: "0.5.0",
			latestReleasedVersion: "0.4.1",
		}),
		"0.6.0",
	);
});

test("bumps from release history when the repository lags behind", () => {
	assert.equal(
		resolveVersion({
			args: ["--next", "patch"],
			rootVersion: "0.3.0",
			latestReleasedVersion: "0.4.1",
		}),
		"0.4.2",
	);
	assert.equal(
		resolveVersion({
			args: ["--next", "patch"],
			rootVersion: "0.4.1",
			latestReleasedVersion: null,
		}),
		"0.4.2",
	);
});

test("rejects --next without a release type", () => {
	for (const args of [["--next"], ["--next", "--check"]]) {
		assert.throws(
			() =>
				resolveVersion({
					args,
					rootVersion: "0.4.1",
					latestReleasedVersion: "0.4.1",
				}),
			/--next requires a release type/,
		);
	}

	assert.throws(
		() =>
			resolveVersion({
				args: ["--next", "prerelease"],
				rootVersion: "0.4.1",
				latestReleasedVersion: "0.4.1",
			}),
		/Invalid release type/,
	);
});
