import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const messagesDir = path.resolve(packageDir, "messages");

let isRunning = false;
let pendingRun = false;
let debounceTimer;

function runGenerate() {
	if (isRunning) {
		pendingRun = true;
		return;
	}

	isRunning = true;
	const child = spawn(process.execPath, ["./scripts/generate-paraglide.mjs"], {
		cwd: packageDir,
		stdio: "inherit",
	});

	child.on("exit", () => {
		isRunning = false;
		if (pendingRun) {
			pendingRun = false;
			runGenerate();
		}
	});
}

function scheduleRun() {
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(runGenerate, 150);
}

runGenerate();

const watcher = fs.watch(
	messagesDir,
	{ recursive: true },
	(_eventType, fileName) => {
		if (!fileName || !fileName.endsWith(".json")) {
			return;
		}
		scheduleRun();
	},
);

watcher.on("error", (error) => {
	console.error("[i18n:watch] watcher error", error);
});

process.on("SIGINT", () => {
	watcher.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	watcher.close();
	process.exit(0);
});
