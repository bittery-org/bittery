// Bun keeps module mocks and DOM globals across files in one test process.
// Each file gets its own process, as in the Extension runner. React tests
// preload a DOM before react-dom is imported; other files retain their own setup.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const TEST_SUFFIXES = [
	".test.js",
	".test.jsx",
	".test.ts",
	".test.tsx",
	".test.mjs",
	".test.cjs",
	".test.mts",
	".test.cts",
];

function testFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const name = path.join(directory, entry.name);
			if (entry.isDirectory()) return testFiles(name);
			return entry.isFile() &&
				TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
				? [name]
				: [];
		})
		.sort();
}

const files = ["src", "scripts"].flatMap(testFiles);
if (files.length === 0) {
	console.error("No Web test files found under src or scripts.");
	process.exit(1);
}

const failed = [];
for (const file of files) {
	const args = ["test"];
	if (file.endsWith(".tsx")) {
		args.push(
			"--preload",
			"../../packages/client-runtime/src/testing/jsdom-preload.ts",
		);
	}
	args.push(file);
	const result = spawnSync("bun", args, { stdio: "inherit" });
	if (result.error || result.status !== 0) {
		failed.push(file);
		console.error(
			`Web test child failed: ${file} (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`,
		);
	}
}

if (failed.length > 0) {
	console.error(`\n${failed.length} of ${files.length} Web test files failed:`);
	for (const file of failed) console.error(`  ${file}`);
	process.exit(1);
}

console.log(`\nAll ${files.length} Web test files passed.`);
