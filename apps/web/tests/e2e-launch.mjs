#!/usr/bin/env node
/**
 * `webServer` command for an E2E API server.
 *
 * Playwright starts every `webServer` *before* `globalSetup`, and the server
 * runs pending migrations on boot, so the database reset has to happen here -
 * a reset in `globalSetup` would land after the server already migrated and
 * opened connections against the old database.
 *
 * Everything is taken from the environment the config passes in, so one script
 * serves both the cloud and the self-hosted API entries:
 *   DATABASE_URL             - reset with `migrate --fresh` (guarded server-side
 *                              to `bittery_e2e*` / `bittery_test*` names)
 *   BITTERY_DEV_MAIL_OUTBOX  - truncated so a run never reads a stale code
 * plus every variable the server itself reads (PORT, BITTERY_MODE, ...).
 */
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = resolve(repoRoot, "apps/server/Cargo.toml");
// Cargo writes to CARGO_TARGET_DIR when it is set, so reading the binaries from
// the default location would find a stale build or none at all.
const targetDir = process.env.CARGO_TARGET_DIR
	? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
	: resolve(repoRoot, "apps/server/target");
const binDir = resolve(targetDir, "debug");

function fail(message) {
	console.error(`[e2e-launch] ${message}`);
	process.exit(1);
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		fail(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} exited with ${result.status}`);
	}
}

const outboxPath = process.env.BITTERY_DEV_MAIL_OUTBOX;
if (!outboxPath) {
	fail("BITTERY_DEV_MAIL_OUTBOX is required; waitForCode() reads that file.");
}
if (!process.env.DATABASE_URL) {
	fail("DATABASE_URL is required so the E2E database can be reset.");
}

mkdirSync(dirname(outboxPath), { recursive: true });
writeFileSync(outboxPath, "");

// Standalone launch builds by default; explicit preparation also applies to
// Playwright's child launchers, including a caller-selected CARGO_TARGET_DIR.
if (process.env.E2E_SERVER_BINARIES_READY !== "1") {
	run("cargo", [
		"build",
		"--manifest-path",
		manifestPath,
		"--bin",
		"bittery-server",
		"--bin",
		"migrate",
	]);
}
const migrateBin = resolve(binDir, "migrate");
const serverBin = resolve(binDir, "bittery-server");
// Check both before resetting the database: an incomplete prebuild cannot boot.
for (const binary of [migrateBin, serverBin]) {
	try {
		if (!statSync(binary).isFile()) throw new Error("not a regular file");
		accessSync(binary, constants.X_OK);
	} catch (error) {
		fail(`Required E2E binary ${binary} is unavailable: ${error.message}`);
	}
}
run(migrateBin, ["--fresh"]);

// POSIX-only, and Node 22.12+. Without this the failure surfaces as a Playwright
// `webServer` timeout, which reads as a broken app rather than a broken launcher.
if (typeof process.execve !== "function") {
	fail(
		`process.execve is unavailable on ${process.platform} / Node ${process.version}; the E2E API server cannot be launched here.`,
	);
}
process.chdir(repoRoot);
// A real exec, not a child: Playwright kills this pid on teardown and the
// server has to be the thing that receives it.
process.execve(serverBin, [serverBin], process.env);
