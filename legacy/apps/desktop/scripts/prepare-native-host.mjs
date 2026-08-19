import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(desktopDir, "src-tauri");
const rustcVersion = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const hostTarget = rustcVersion.match(/^host: (.+)$/m)?.[1];
const target =
	process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget;

if (!target) {
	throw new Error("Could not determine the Rust target triple");
}

execFileSync(
	"cargo",
	["build", "--release", "--bin", "bittery-native-host", "--target", target],
	{ cwd: tauriDir, stdio: "inherit" },
);

const binaryName = target.includes("windows")
	? "bittery-native-host.exe"
	: "bittery-native-host";
const bundleResourcesDir = join(tauriDir, "target", "bundle-resources");

mkdirSync(bundleResourcesDir, { recursive: true });
cpSync(
	join(tauriDir, "target", target, "release", binaryName),
	join(bundleResourcesDir, binaryName),
);
