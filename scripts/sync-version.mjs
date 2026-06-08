import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootPackagePath = resolve("package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const explicitVersion = args.find((arg) => !arg.startsWith("--"));
const version = explicitVersion ?? rootPackage.version;

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
	console.error(
		`Invalid version "${version}". Expected semver like 1.2.3 in root package.json or as an argument.`,
	);
	process.exit(1);
}

function readJson(path) {
	return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function writeJson(path, value) {
	writeFileSync(resolve(path), `${JSON.stringify(value, null, "\t")}\n`);
}

function updateCargoToml(path, nextVersion) {
	const absolutePath = resolve(path);
	const content = readFileSync(absolutePath, "utf8");
	const updated = content.replace(
		/^version\s*=\s*"[^"]*"/m,
		`version = "${nextVersion}"`,
	);

	if (updated === content) {
		throw new Error(`Could not update version in ${path}`);
	}

	if (!checkOnly) {
		writeFileSync(absolutePath, updated);
	}
}

function syncJsonVersion(path, updater) {
	const current = readJson(path);
	const next = updater(current);
	const currentVersion = JSON.stringify(current);
	const nextVersion = JSON.stringify(next);

	if (currentVersion !== nextVersion) {
		if (checkOnly) {
			console.error(`Version drift in ${path}`);
			process.exit(1);
		}
		writeJson(path, next);
	}
}

syncJsonVersion("apps/desktop/package.json", (pkg) => ({ ...pkg, version }));
syncJsonVersion("apps/extension/package.json", (pkg) => ({ ...pkg, version }));
syncJsonVersion("apps/desktop/src-tauri/tauri.conf.json", (config) => ({
	...config,
	version,
}));
syncJsonVersion("apps/mobile/app.json", (config) => ({
	...config,
	expo: {
		...config.expo,
		version,
	},
}));

for (const cargoPath of [
	"apps/server/Cargo.toml",
	"apps/desktop/src-tauri/Cargo.toml",
]) {
	const absolutePath = resolve(cargoPath);
	const content = readFileSync(absolutePath, "utf8");
	const match = content.match(/^version\s*=\s*"([^"]*)"/m);

	if (!match) {
		console.error(`Could not read version from ${cargoPath}`);
		process.exit(1);
	}

	if (match[1] !== version) {
		if (checkOnly) {
			console.error(`Version drift in ${cargoPath}`);
			process.exit(1);
		}
		updateCargoToml(cargoPath, version);
	}
}

if (!checkOnly && rootPackage.version !== version) {
	rootPackage.version = version;
	writeJson("package.json", rootPackage);
}

if (checkOnly) {
	console.log(`All release surfaces are synced to version ${version}`);
} else {
	console.log(`Synced release surfaces to version ${version}`);
}
