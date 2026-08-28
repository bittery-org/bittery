import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(repositoryRoot, "packages/client-runtime");
const runnerPath = path.join(packageRoot, "scripts/test-chromium.mjs");

test("client Runtime Chromium acceptance is one serial Xvfb-backed CI gate", async (context) => {
	const fixtureDirectory = await mkdtemp(
		path.join(tmpdir(), "bittery-chromium-ci-"),
	);
	context.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
	const logPath = path.join(fixtureDirectory, "invocations.jsonl");
	const lockPath = path.join(fixtureDirectory, "active.lock");
	const xvfbPath = path.join(fixtureDirectory, "xvfb-run");
	await writeFile(
		xvfbPath,
		`#!/usr/bin/env node
import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";
const logPath = process.env.BITTERY_CHROMIUM_GATE_LOG;
const lockPath = process.env.BITTERY_CHROMIUM_GATE_LOCK;
let lock;
try {
  lock = openSync(lockPath, "wx");
} catch {
  appendFileSync(logPath, JSON.stringify({ concurrent: true }) + "\\n");
  process.exit(91);
}
appendFileSync(logPath, JSON.stringify({ event: "start", args: process.argv.slice(2) }) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 20));
appendFileSync(logPath, JSON.stringify({ event: "end", args: process.argv.slice(2) }) + "\\n");
closeSync(lock);
rmSync(lockPath);
`,
	);
	await chmod(xvfbPath, 0o755);

	const result = spawnSync(process.execPath, [runnerPath], {
		cwd: packageRoot,
		encoding: "utf8",
		env: {
			...process.env,
			BITTERY_CHROMIUM_GATE_LOCK: lockPath,
			BITTERY_CHROMIUM_GATE_LOG: logPath,
			PATH: `${fixtureDirectory}:${process.env.PATH}`,
		},
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);

	const invocations = (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		invocations,
		[
			"tests/web-account-lease.chromium.test.ts",
			"tests/web-binary-transfer.chromium.test.ts",
			"tests/opfs-upload-spool.chromium.test.ts",
		].flatMap((suite) => [
			{
				event: "start",
				args: [
					"--auto-servernum",
					"--server-args=-screen 0 1280x1024x24",
					"bun",
					"test",
					suite,
				],
			},
			{
				event: "end",
				args: [
					"--auto-servernum",
					"--server-args=-screen 0 1280x1024x24",
					"bun",
					"test",
					suite,
				],
			},
		]),
	);
});

test("client Runtime Chromium acceptance fails before running when Xvfb is unavailable", async (context) => {
	const emptyPath = await mkdtemp(
		path.join(tmpdir(), "bittery-chromium-ci-empty-"),
	);
	context.after(() => rm(emptyPath, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [runnerPath], {
		cwd: packageRoot,
		encoding: "utf8",
		env: { ...process.env, PATH: emptyPath },
	});

	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/xvfb-run is required for the client Runtime Chromium acceptance gate/i,
	);
});

test("the public binary-transfer Chromium alias uses the same closed Xvfb gate", async (context) => {
	const fixtureDirectory = await mkdtemp(
		path.join(tmpdir(), "bittery-binary-chromium-ci-"),
	);
	const emptyPath = await mkdtemp(
		path.join(tmpdir(), "bittery-binary-chromium-ci-empty-"),
	);
	context.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
	context.after(() => rm(emptyPath, { recursive: true, force: true }));
	const logPath = path.join(fixtureDirectory, "invocation.json");
	const xvfbPath = path.join(fixtureDirectory, "xvfb-run");
	await writeFile(
		xvfbPath,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.BITTERY_CHROMIUM_GATE_LOG, JSON.stringify(process.argv.slice(2)));
`,
	);
	await chmod(xvfbPath, 0o755);

	const selected = spawnSync(
		process.execPath,
		[runnerPath, "binary-transfer"],
		{
			cwd: packageRoot,
			encoding: "utf8",
			env: {
				...process.env,
				BITTERY_CHROMIUM_GATE_LOG: logPath,
				PATH: `${fixtureDirectory}:${process.env.PATH}`,
			},
		},
	);
	assert.equal(selected.status, 0, selected.stderr || selected.stdout);
	assert.deepEqual(JSON.parse(await readFile(logPath, "utf8")), [
		"--auto-servernum",
		"--server-args=-screen 0 1280x1024x24",
		"bun",
		"test",
		"tests/web-binary-transfer.chromium.test.ts",
	]);

	const unavailable = spawnSync(
		process.execPath,
		[runnerPath, "binary-transfer"],
		{
			cwd: packageRoot,
			encoding: "utf8",
			env: { ...process.env, PATH: emptyPath },
		},
	);
	assert.notEqual(unavailable.status, 0);
	assert.match(
		unavailable.stderr,
		/xvfb-run is required for the client Runtime Chromium acceptance gate/i,
	);

	const runtimePackage = JSON.parse(
		await readFile(path.join(packageRoot, "package.json"), "utf8"),
	);
	assert.equal(
		runtimePackage.scripts["test:binary-transfer:chromium"],
		"node ./scripts/test-chromium.mjs binary-transfer",
	);
});

test("root check:ci reaches the named client Runtime Chromium acceptance gate", async () => {
	const rootPackage = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	const runtimePackage = JSON.parse(
		await readFile(path.join(packageRoot, "package.json"), "utf8"),
	);

	assert.equal(
		runtimePackage.scripts["test:chromium"],
		"node ./scripts/test-chromium.mjs",
	);
	assert.equal(
		rootPackage.scripts["check:ci"].match(
			/pnpm --filter @bittery\/client-runtime run test:chromium/g,
		)?.length,
		1,
	);
});
