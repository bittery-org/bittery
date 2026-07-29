// Runs each test file in its own `bun test` process.
//
// `bun test` shares one process across every file it is given, and
// `mock.module` registers a replacement process-wide and permanently — there is
// no per-file reset and no unmock. So a file that stubs a module leaks that stub
// into every file loaded after it:
//
//   * auth-handlers.test.ts replaces `@bittery/core` with the four functions it
//     needs, which deletes `createCoreContext` for anything loaded later. Files
//     reaching it through `background/core-instance.ts` then die on import with
//     "Export named 'createCoreContext' not found".
//   * auth-handlers, autofill-handlers and native-messaging each stub
//     `background/session-manager.ts`, which is the module
//     session-manager.test.ts exists to test. Whichever stub was registered
//     first is what that test file gets instead of the real implementation.
//
// Whether either bites depends on the order `bun test` walks the directories,
// and that differs between filesystems — the suite passed on macOS and failed on
// CI's Linux checkout with four failures and eight files that never loaded.
//
// The test files are each written as a self-contained world, which is the right
// way to write them; they just need the isolation to match. Giving each file its
// own process is that isolation, and it keeps the mocks readable rather than
// forcing every one of them to reconstruct the real module's full export list.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const TEST_DIRS = ["tests/background", "tests/content-script", "tests/lib"];

const files = TEST_DIRS.flatMap((dir) =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => path.join(dir, name)),
);

if (files.length === 0) {
	console.error("No test files found. Did the test directories move?");
	process.exit(1);
}

const failed = [];

for (const file of files) {
	const { status } = spawnSync("bun", ["test", file], { stdio: "inherit" });
	if (status !== 0) {
		failed.push(file);
	}
}

if (failed.length > 0) {
	console.error(`\n${failed.length} of ${files.length} test files failed:`);
	for (const file of failed) {
		console.error(`  ${file}`);
	}
	process.exit(1);
}

console.log(`\nAll ${files.length} test files passed.`);
