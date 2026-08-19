import { execFileSync } from "node:child_process";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
	const match = STABLE_VERSION.exec(value);
	if (!match) {
		throw new Error(
			`Invalid version "${value}". Expected stable SemVer like 1.2.3.`,
		);
	}

	return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);

	for (let index = 0; index < leftParts.length; index += 1) {
		const difference = leftParts[index] - rightParts[index];
		if (difference !== 0) return Math.sign(difference);
	}

	return 0;
}

export function bumpVersion(version, releaseType) {
	const [major, minor, patch] = parseVersion(version);
	switch (releaseType) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		default:
			throw new Error(
				`Invalid release type "${releaseType}". Expected major, minor, or patch.`,
			);
	}
}

export function resolveVersion({ args, rootVersion, latestReleasedVersion }) {
	const nextIndex = args.indexOf("--next");
	const releaseType = nextIndex === -1 ? null : args[nextIndex + 1];

	if (nextIndex !== -1 && (!releaseType || releaseType.startsWith("--"))) {
		throw new Error("--next requires a release type: major, minor, or patch.");
	}

	if (!releaseType) {
		const explicitVersion = args.find((arg) => !arg.startsWith("--"));
		return explicitVersion ?? rootVersion;
	}

	// A merged release pull request leaves the repository ahead of the tags until
	// tagging succeeds, so bumping from the tag alone would walk the version back.
	const base =
		latestReleasedVersion &&
		compareVersions(latestReleasedVersion, rootVersion) > 0
			? latestReleasedVersion
			: rootVersion;

	return bumpVersion(base, releaseType);
}

export function latestVersionFromTags(tags) {
	const versions = tags
		.map((tag) => tag.trim())
		.filter((tag) => /^v\d/.test(tag))
		.map((tag) => tag.slice(1))
		.filter((version) => STABLE_VERSION.test(version));

	if (versions.length === 0) return null;
	return versions.sort(compareVersions).at(-1);
}

export function readReleaseTags() {
	const output = execFileSync("git", ["tag", "--list", "v*"], {
		encoding: "utf8",
	});
	return output.split("\n");
}
