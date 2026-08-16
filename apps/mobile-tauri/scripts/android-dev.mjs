#!/usr/bin/env node
/**
 * `tauri android dev`, plus the port forwarding that makes it actually usable.
 *
 * Tauri reverses the Vite dev-server port for you, but nothing reverses the *backend* port. On
 * a device or an emulator `localhost` means the handset, not your Mac, so an account whose
 * server URL is `http://localhost:3000` — which is the default, and what every dev account
 * stores — cannot reach the API at all. Sync fails with a transport error and the app quietly
 * runs on cached data.
 *
 * `adb reverse tcp:P tcp:P` makes the handset's `localhost:P` tunnel to the host's, so the
 * stored URL is correct as written. That beats rewriting the URL to `10.0.2.2`, which is
 * emulator-only and would bake a wrong value into stored account metadata.
 *
 * The tunnel is re-asserted on a timer rather than set up once: it is per-device and does not
 * survive an emulator restart, a cable unplug, or a device connecting after the build started.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RECHECK_INTERVAL_MS = 5000;

/** Ports the handset must be able to reach on the host, deduped. */
function resolvePorts() {
	const ports = new Set();

	// The backend. `.env` may override it; the fallback matches `auth-server.ts`.
	const serverUrl = process.env.VITE_SERVER_URL ?? "http://localhost:3000";
	try {
		const { port, protocol } = new URL(serverUrl);
		ports.add(Number(port) || (protocol === "https:" ? 443 : 80));
	} catch {
		console.warn(
			`[android-dev] VITE_SERVER_URL is not a URL (${serverUrl}); defaulting to 3000`,
		);
		ports.add(3000);
	}

	// The Vite dev server. Tauri reverses this itself, but re-asserting is free and covers a
	// device that reconnects mid-session, which Tauri does not re-handle.
	ports.add(3040);

	return [...ports];
}

function resolveAdb() {
	const sdk =
		process.env.ANDROID_HOME ??
		process.env.ANDROID_SDK_ROOT ??
		join(homedir(), "Library", "Android", "sdk");
	const binary = process.platform === "win32" ? "adb.exe" : "adb";
	const bundled = join(sdk, "platform-tools", binary);
	// Falling back to a bare `adb` lets a PATH install work even with no SDK env var set.
	return existsSync(bundled) ? bundled : binary;
}

const adb = resolveAdb();
const ports = resolvePorts();

function listDevices() {
	const result = spawnSync(adb, ["devices"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return [];
	return (
		result.stdout
			.split("\n")
			.slice(1)
			.map((line) => line.trim().split(/\s+/))
			// Only "device" — a handset still in "offline" or "unauthorized" rejects `reverse`.
			.filter(([serial, state]) => serial && state === "device")
			.map(([serial]) => serial)
	);
}

const announced = new Set();

function ensureTunnels() {
	for (const serial of listDevices()) {
		const existing = spawnSync(adb, ["-s", serial, "reverse", "--list"], {
			encoding: "utf8",
		});
		const listed = existing.status === 0 ? existing.stdout : "";

		for (const port of ports) {
			if (listed.includes(`tcp:${port} tcp:${port}`)) continue;

			const added = spawnSync(
				adb,
				["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`],
				{ encoding: "utf8" },
			);
			const key = `${serial}:${port}`;
			if (added.status === 0) {
				console.log(
					`[android-dev] ${serial}: localhost:${port} -> host:${port}`,
				);
				announced.delete(key);
			} else if (!announced.has(key)) {
				// Announce a failure once per device+port so a permanently broken tunnel is
				// visible without spamming the log every five seconds.
				announced.add(key);
				console.warn(
					`[android-dev] ${serial}: could not reverse tcp:${port} — ${(added.stderr || "").trim()}`,
				);
			}
		}
	}
}

ensureTunnels();
const timer = setInterval(ensureTunnels, RECHECK_INTERVAL_MS);

const tauri = spawn(
	process.platform === "win32" ? "pnpm.cmd" : "pnpm",
	["exec", "tauri", "android", "dev", ...process.argv.slice(2)],
	{ stdio: "inherit" },
);

const stop = (signal) => {
	clearInterval(timer);
	if (!tauri.killed) tauri.kill(signal);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

tauri.on("exit", (code, signal) => {
	clearInterval(timer);
	// Preserve the child's exit status so CI and shell `&&` chains still behave.
	process.exit(signal ? 1 : (code ?? 0));
});
