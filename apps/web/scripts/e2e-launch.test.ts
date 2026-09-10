import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(
	new URL("../tests/e2e-launch.mjs", import.meta.url),
);
const fixtures: string[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0))
		rmSync(fixture, { recursive: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bittery-e2e-launch-"));
	fixtures.push(root);
	const tools = join(root, "tools");
	const target = join(root, "target with spaces");
	const binaries = join(target, "debug");
	mkdirSync(tools);
	mkdirSync(binaries, { recursive: true });
	const events = join(root, "events");
	const outbox = join(root, "outbox");
	writeFileSync(events, "");
	writeFileSync(outbox, "stale mail");
	function executable(path: string, body: string) {
		writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
		chmodSync(path, 0o755);
	}
	executable(join(tools, "cargo"), 'echo cargo >> "$LAUNCH_EVENTS"');
	executable(
		join(binaries, "migrate"),
		'echo "migrate:$*" >> "$LAUNCH_EVENTS"\nexit "$MIGRATE_EXIT"',
	);
	executable(
		join(binaries, "bittery-server"),
		'test ! -s "$BITTERY_DEV_MAIL_OUTBOX"\necho server >> "$LAUNCH_EVENTS"',
	);
	return {
		binaries,
		run(extra: Record<string, string> = {}) {
			const result = spawnSync("node", [launcher], {
				encoding: "utf8",
				env: {
					...process.env,
					E2E_SERVER_BINARIES_READY: "",
					CARGO_TARGET_DIR: target,
					PATH: `${tools}:${process.env.PATH}`,
					LAUNCH_EVENTS: events,
					MIGRATE_EXIT: "0",
					BITTERY_DEV_MAIL_OUTBOX: outbox,
					DATABASE_URL: "postgres://unused/bittery_e2e_launcher_test",
					...extra,
				},
			});
			expect(result.error).toBeUndefined();
			return {
				...result,
				events: readFileSync(events, "utf8").trim().split("\n").filter(Boolean),
			};
		},
	};
}

describe("E2E child launcher", () => {
	test("explicit prebuilt binaries skip Cargo but still reset and launch", () => {
		const result = fixture().run({ E2E_SERVER_BINARIES_READY: "1" });
		expect(result.status).toBe(0);
		expect(result.events).toEqual(["migrate:--fresh", "server"]);
	});

	for (const flag of ["", "0"]) {
		test(`standalone launch builds unless explicitly prebuilt (flag ${JSON.stringify(flag)})`, () => {
			const result = fixture().run({ E2E_SERVER_BINARIES_READY: flag });
			expect(result.status).toBe(0);
			expect(result.events).toEqual(["cargo", "migrate:--fresh", "server"]);
		});
	}

	for (const binary of ["migrate", "bittery-server"]) {
		test(`missing prebuilt ${binary} fails before migration`, () => {
			const files = fixture();
			rmSync(join(files.binaries, binary));
			const result = files.run({ E2E_SERVER_BINARIES_READY: "1" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(binary);
			expect(result.events).toEqual([]);
		});
	}

	for (const invalid of ["directory", "not executable"]) {
		test(`invalid prebuilt server (${invalid}) fails before migration`, () => {
			const files = fixture();
			const server = join(files.binaries, "bittery-server");
			if (invalid === "directory") {
				rmSync(server);
				mkdirSync(server);
			} else chmodSync(server, 0o644);
			const result = files.run({ E2E_SERVER_BINARIES_READY: "1" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("bittery-server");
			expect(result.events).toEqual([]);
		});
	}

	test("migration failure never launches the prebuilt server", () => {
		const result = fixture().run({
			E2E_SERVER_BINARIES_READY: "1",
			MIGRATE_EXIT: "9",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("exited with 9");
		expect(result.events).toEqual(["migrate:--fresh"]);
	});
});
