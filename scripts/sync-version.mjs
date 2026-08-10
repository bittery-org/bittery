import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	compareVersions,
	latestVersionFromTags,
	parseVersion,
	readReleaseTags,
	resolveVersion,
} from "./release-version.mjs";

function main() {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const checkHistory = args.includes("--check-history");
	const allowNoReleases = args.includes("--allow-no-releases");
	const isBump = args.includes("--next");

	const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
	const latestReleasedVersion =
		isBump || checkHistory ? latestVersionFromTags(readReleaseTags()) : null;

	// A missing tag list is far more likely to be a shallow checkout than a repo
	// that has never released, and passing silently would hide the lost safeguard.
	if (checkHistory && !latestReleasedVersion && !allowNoReleases) {
		throw new Error(
			"No stable release tags found. Check out with fetch-depth: 0, or pass --allow-no-releases for a first release.",
		);
	}

	const version = resolveVersion({
		args,
		rootVersion: rootPackage.version,
		latestReleasedVersion,
	});

	parseVersion(version);

	if (
		checkHistory &&
		latestReleasedVersion &&
		compareVersions(version, latestReleasedVersion) < 0
	) {
		throw new Error(
			`Repository version ${version} is older than latest release v${latestReleasedVersion}.`,
		);
	}

	if (isBump) {
		if (
			latestReleasedVersion &&
			compareVersions(version, latestReleasedVersion) <= 0
		) {
			throw new Error(
				`Next version must be newer than v${latestReleasedVersion}.`,
			);
		}

		if (compareVersions(version, rootPackage.version) <= 0) {
			throw new Error(
				`Next version must be newer than repository version ${rootPackage.version}.`,
			);
		}
	}

	function replace(path, pattern, replacement, group = 1) {
		const absolutePath = resolve(path);
		const content = readFileSync(absolutePath, "utf8");
		const match = content.match(pattern);
		if (!match) throw new Error(`Could not read version from ${path}.`);

		if (match[group] === version) return;
		if (checkOnly)
			throw new Error(`Version drift in ${path}: found ${match[group]}.`);

		writeFileSync(absolutePath, content.replace(pattern, replacement));
	}

	const jsonVersion = /"version":\s*"([^"]+)"/;
	for (const path of [
		"package.json",
		"apps/desktop/package.json",
		"apps/extension/package.json",
		"apps/desktop/src-tauri/tauri.conf.json",
		"apps/mobile/app.json",
	]) {
		replace(path, jsonVersion, `"version": "${version}"`);
	}

	for (const path of [
		"apps/server/Cargo.toml",
		"apps/desktop/src-tauri/Cargo.toml",
	]) {
		replace(path, /^version\s*=\s*"([^"]+)"/m, `version = "${version}"`);
	}

	for (const [path, packageName] of [
		["apps/server/Cargo.lock", "bittery-server"],
		["apps/desktop/src-tauri/Cargo.lock", "Bittery"],
	]) {
		replace(
			path,
			new RegExp(
				`(\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = )"([^"]+)"`,
			),
			`$1"${version}"`,
			2,
		);
	}

	const status = checkOnly
		? "All release surfaces are synced at"
		: "Synced release surfaces to";
	console.log(`${status} version ${version}`);
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
