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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = resolve(repoRoot, "apps/server/Cargo.toml");
const binDir = resolve(repoRoot, "apps/server/target/debug");

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

// playwright.config.ts already builds these before any server starts, so this
// is a ~1s fingerprint check there; it stays so the script also runs standalone.
run("cargo", [
	"build",
	"--manifest-path",
	manifestPath,
	"--bin",
	"bittery-server",
	"--bin",
	"migrate",
]);
run(resolve(binDir, "migrate"), ["--fresh"]);

const serverBin = resolve(binDir, "bittery-server");
process.chdir(repoRoot);
// A real exec, not a child: Playwright kills this pid on teardown and the
// server has to be the thing that receives it.
process.execve(serverBin, [serverBin], process.env);
