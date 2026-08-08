import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	bumpVersion,
	compareVersions,
	latestVersionFromTags,
	parseVersion,
	readReleaseTags,
} from "./release-version.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const checkHistory = args.includes("--check-history");
const nextIndex = args.indexOf("--next");
const releaseType = nextIndex === -1 ? null : args[nextIndex + 1];
const explicitVersion = args.find(
	(arg, index) => !arg.startsWith("--") && index !== nextIndex + 1,
);

const rootPackagePath = resolve("package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const latestReleasedVersion = latestVersionFromTags(readReleaseTags());
const version = releaseType
	? bumpVersion(latestReleasedVersion ?? rootPackage.version, releaseType)
	: (explicitVersion ?? rootPackage.version);

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

if (
	releaseType &&
	latestReleasedVersion &&
	compareVersions(version, latestReleasedVersion) <= 0
) {
	throw new Error(`Next version must be newer than v${latestReleasedVersion}.`);
}

function replace(path, pattern, replacement, expectedVersion) {
	const absolutePath = resolve(path);
	const content = readFileSync(absolutePath, "utf8");
	const match = content.match(pattern);
	if (!match) throw new Error(`Could not read version from ${path}.`);

	if (match[1] === expectedVersion) return;
	if (checkOnly)
		throw new Error(`Version drift in ${path}: found ${match[1]}.`);

	writeFileSync(absolutePath, content.replace(pattern, replacement));
}

const jsonVersions = [
	["package.json", /"version":\s*"([^"]+)"/, `"version": "${version}"`],
	[
		"apps/desktop/package.json",
		/"version":\s*"([^"]+)"/,
		`"version": "${version}"`,
	],
	[
		"apps/extension/package.json",
		/"version":\s*"([^"]+)"/,
		`"version": "${version}"`,
	],
	[
		"apps/desktop/src-tauri/tauri.conf.json",
		/"version":\s*"([^"]+)"/,
		`"version": "${version}"`,
	],
	["apps/mobile/app.json", /"version":\s*"([^"]+)"/, `"version": "${version}"`],
];

for (const [path, pattern, replacement] of jsonVersions) {
	replace(path, pattern, replacement, version);
}

for (const path of [
	"apps/server/Cargo.toml",
	"apps/desktop/src-tauri/Cargo.toml",
]) {
	replace(path, /^version\s*=\s*"([^"]+)"/m, `version = "${version}"`, version);
}

for (const [path, packageName] of [
	["apps/server/Cargo.lock", "bittery-server"],
	["apps/desktop/src-tauri/Cargo.lock", "Bittery"],
]) {
	const pattern = new RegExp(
		`(\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = )"([^"]+)"`,
	);
	const absolutePath = resolve(path);
	const content = readFileSync(absolutePath, "utf8");
	const match = content.match(pattern);
	if (!match)
		throw new Error(`Could not read ${packageName} version from ${path}.`);
	if (match[2] === version) continue;
	if (checkOnly)
		throw new Error(`Version drift in ${path}: found ${match[2]}.`);
	writeFileSync(absolutePath, content.replace(pattern, `$1"${version}"`));
}

const status = checkOnly
	? "All release surfaces are synced at"
	: "Synced release surfaces to";
console.log(`${status} version ${version}`);
