// Real Linux Tauri/WebKit smoke for the existing production composition. This does not
// establish Rust Account ownership, authenticated restart, Replica durability or biometry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	access,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

assert.equal(
	process.platform,
	"linux",
	"This isolation harness requires Linux",
);
const { values } = parseArgs({
	options: {
		driver: { type: "string", default: "tauri-driver" },
		"webkit-driver": { type: "string", default: "WebKitWebDriver" },
		application: {
			type: "string",
			default: fileURLToPath(
				new URL("../../src-tauri/target/debug/Bittery", import.meta.url),
			),
		},
	},
});

async function executable(name) {
	const candidates = name.includes("/")
		? [resolve(name)]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.map((directory) => join(directory, name));
	for (const candidate of candidates) {
		if (
			await access(candidate).then(
				() => true,
				() => false,
			)
		)
			return realpath(candidate);
	}
	throw new Error(`Required executable is unavailable: ${name}`);
}

async function freePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((done) => server.close(done));
	return port;
}

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const application = await realpath(values.application);
const driverBinary = await executable(values.driver);
const webkitBinary = await executable(values["webkit-driver"]);
for (const dependency of ["xvfb-run", "bwrap", "dbus-run-session", "python3"])
	await executable(dependency);
const directory = await mkdtemp(join(tmpdir(), "bittery-desktop-smoke-"));
for (const name of ["home", "data", "config", "cache", "run", "tmp"]) {
	await mkdir(join(directory, name), { mode: 0o700 });
}
// This marker identifies only the application's isolated mount namespace, without reading
// another running Bittery process's environment or touching its profile.
const marker = `.bittery-smoke-${directory.split("/").at(-1)}`;
await writeFile(join(directory, "home", marker), directory);
const driverPort = await freePort();
let webkitPort = await freePort();
while (webkitPort === driverPort) webkitPort = await freePort();
const log = await open(join(directory, "driver.log"), "w");
const child = spawn(
	"xvfb-run",
	[
		"-a",
		"sh",
		fileURLToPath(new URL("./isolated-driver.sh", import.meta.url)),
		directory,
		repository,
		homedir(),
		driverBinary,
		webkitBinary,
		String(driverPort),
		String(webkitPort),
		application,
	],
	{ detached: true, stdio: ["ignore", log.fd, log.fd] },
);
let sessionId;
let childExited = false;
let childError;
const childExit = new Promise((done) => {
	child.once("exit", () => {
		childExited = true;
		done();
	});
	child.once("error", (error) => {
		childExited = true;
		childError = error;
		done();
	});
});
const evidence = {
	startedAt: new Date().toISOString(),
	kind: "legacy-production-composition-smoke",
	application,
	assertions: [],
	limitations: [
		"No authentication, Rust Account ownership, Replica durability or native messaging acceptance",
		"Linux WebKitGTK does not establish macOS/Windows biometric acceptance",
	],
};

async function call(path, body, method = body === undefined ? "GET" : "POST") {
	const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
		method,
		signal: AbortSignal.timeout(65_000),
		...(body === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	const result = await response.json();
	if (!response.ok) throw new Error(JSON.stringify(result));
	return result.value;
}

function evaluate(script) {
	return call(`/session/${sessionId}/execute/sync`, { script, args: [] });
}

async function appPids() {
	const pids = [];
	for (const pid of await readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue;
		if ((await readlink(`/proc/${pid}/exe`).catch(() => null)) !== application)
			continue;
		const identity = await readFile(
			`/proc/${pid}/root${homedir()}/${marker}`,
			"utf8",
		).catch(() => null);
		if (identity === directory) pids.push(Number(pid));
	}
	return pids;
}

async function waitForLogin() {
	const deadline = Date.now() + 60_000;
	let state;
	while (Date.now() < deadline) {
		state = await evaluate(
			"return {url:location.href,tauri:!!window.__TAURI_INTERNALS__,text:document.body.innerText,marker:window.acceptanceMarker??null};",
		);
		if (
			state.tauri &&
			state.url.endsWith("/login") &&
			state.text.includes("Sign in to your account")
		)
			return state;
		await delay(250);
	}
	throw new Error(
		`Native renderer did not reach Login: ${JSON.stringify(state)}`,
	);
}

async function startApplication() {
	const opened = await call("/session", {
		capabilities: { alwaysMatch: { "tauri:options": { application } } },
	});
	sessionId = opened.sessionId;
	evidence.capabilities = opened.capabilities;
	return waitForLogin();
}

try {
	const deadline = Date.now() + 15_000;
	while (true) {
		if (childExited)
			throw new Error(
				`WebDriver exited (${childError ?? "see log"}); inspect ${directory}/driver.log`,
			);
		if (
			await call("/status").then(
				(status) => status.ready,
				() => false,
			)
		)
			break;
		if (Date.now() >= deadline)
			throw new Error("WebDriver did not become ready");
		await delay(100);
	}
	evidence.initial = await startApplication();
	const firstPids = await appPids();
	assert.equal(firstPids.length, 1);
	evidence.firstPid = firstPids[0];
	evidence.assertions.push("Real Tauri process renders the existing Login UI");
	const screenshot = await call(`/session/${sessionId}/screenshot`);
	await writeFile(
		join(directory, "login.png"),
		Buffer.from(screenshot, "base64"),
	);
	await evaluate("window.acceptanceMarker='before-refresh';return true;");
	await call(`/session/${sessionId}/refresh`, {});
	evidence.refreshed = await waitForLogin();
	assert.equal(evidence.refreshed.marker, null);
	assert.deepEqual(await appPids(), firstPids);
	evidence.assertions.push(
		"Renderer refresh replaces JavaScript while the native PID survives",
	);
	await call(`/session/${sessionId}`, undefined, "DELETE");
	sessionId = undefined;
	const exitDeadline = Date.now() + 5_000;
	while ((await appPids()).length && Date.now() < exitDeadline)
		await delay(100);
	assert.deepEqual(await appPids(), []);
	evidence.assertions.push("Closing the session exits the native process");
	evidence.restarted = await startApplication();
	const restartedPids = await appPids();
	assert.equal(restartedPids.length, 1);
	assert.notEqual(restartedPids[0], firstPids[0]);
	evidence.restartedPid = restartedPids[0];
	evidence.assertions.push(
		"A new native PID reopens the same isolated profile and renders Login",
	);
	evidence.result = "passed";
} catch (error) {
	evidence.result = "failed";
	evidence.error = String(error);
	process.exitCode = 1;
} finally {
	const cleanupErrors = [];
	if (sessionId) {
		await call(`/session/${sessionId}`, undefined, "DELETE").catch((error) => {
			cleanupErrors.push(`Application session close failed: ${error}`);
		});
	}
	const signalDriver = (signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (error.code !== "ESRCH")
				cleanupErrors.push(`Driver termination failed: ${error}`);
		}
	};
	if (!childExited) {
		signalDriver("SIGTERM");
		await Promise.race([childExit, delay(2_000)]);
		if (!childExited) {
			signalDriver("SIGKILL");
			await Promise.race([childExit, delay(5_000)]);
		}
		if (!childExited)
			cleanupErrors.push("Driver process did not exit after termination");
	}
	const cleanupDeadline = Date.now() + 5_000;
	while ((await appPids()).length && Date.now() < cleanupDeadline)
		await delay(100);
	if ((await appPids()).length)
		cleanupErrors.push(
			"Isolated native application processes remain after cleanup",
		);
	if (cleanupErrors.length) {
		evidence.cleanupErrors = cleanupErrors;
		evidence.result = "failed";
		process.exitCode = 1;
	} else {
		evidence.cleanup = "Application and driver processes exited";
	}
	await log.close();
	evidence.finishedAt = new Date().toISOString();
	await writeFile(
		join(directory, "evidence.json"),
		JSON.stringify(evidence, null, 2),
	);
	console.log(
		JSON.stringify({
			result: evidence.result,
			directory,
			assertions: evidence.assertions,
			error: evidence.error,
		}),
	);
}
