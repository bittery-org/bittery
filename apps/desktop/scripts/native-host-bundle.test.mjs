import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBuildPlatform } from "./build-platform.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = join(desktopDir, "..", "..");

const platformResources = [
	["linux", "bittery-native-host"],
	["macos", "bittery-native-host"],
	["windows", "bittery-native-host.exe"],
];

test("desktop bundles the native messaging host at the resource root", async () => {
	for (const [platform, binaryName] of platformResources) {
		const configPath = join(
			desktopDir,
			"src-tauri",
			`bundle.${platform}.conf.json`,
		);
		const config = JSON.parse(await readFile(configPath, "utf8"));

		assert.deepEqual(config.bundle?.resources, {
			[`target/bundle-resources/${binaryName}`]: binaryName,
		});
	}
});

test("the release workflow builds the native host before the desktop bundle", async () => {
	const workflow = await readFile(
		join(repositoryDir, ".github", "workflows", "release.yml"),
		"utf8",
	);
	const nativeHostBuild = workflow.indexOf("name: Build desktop native host");
	const desktopBundle = workflow.indexOf("name: Build desktop app");

	assert.notEqual(nativeHostBuild, -1);
	assert.ok(nativeHostBuild < desktopBundle);
	assert.match(
		workflow.slice(nativeHostBuild, desktopBundle),
		/node apps\/desktop\/scripts\/prepare-native-host\.mjs \$\{\{ matrix\.target \}\}/,
	);
	for (const [platform] of platformResources) {
		assert.match(
			workflow,
			new RegExp(`bundle_config: bundle\\.${platform}\\.conf\\.json`),
		);
	}
	assert.match(
		workflow,
		/--config src-tauri\/\$\{\{ matrix\.bundle_config \}\}/,
	);
});

test("the Tauri build script does not claim that an environment variable bundles files", async () => {
	const buildScript = await readFile(
		join(desktopDir, "src-tauri", "build.rs"),
		"utf8",
	);

	assert.doesNotMatch(buildScript, /NATIVE_HOST_BINARY_PATH|will be bundled/);
});

test("local desktop release builds select a native-host bundle config", async () => {
	const packageJson = JSON.parse(
		await readFile(join(desktopDir, "package.json"), "utf8"),
	);
	const buildScript = await readFile(
		join(desktopDir, "scripts", "build-desktop.mjs"),
		"utf8",
	);

	assert.equal(
		packageJson.scripts["build:app"],
		"node scripts/build-desktop.mjs",
	);
	assert.match(buildScript, /bundle\.\$\{platform\}\.conf\.json/);
});

test("local desktop builds select configs for both target argument forms", () => {
	assert.equal(
		resolveBuildPlatform(["--target", "aarch64-apple-darwin"], "linux"),
		"macos",
	);
	assert.equal(
		resolveBuildPlatform(["--target=x86_64-pc-windows-msvc"], "linux"),
		"windows",
	);
	assert.equal(resolveBuildPlatform([], "darwin"), "macos");
});
