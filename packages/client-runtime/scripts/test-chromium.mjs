import { spawnSync } from "node:child_process";

const allSuites = [
	"tests/web-account-lease.chromium.test.ts",
	"tests/web-binary-transfer.chromium.test.ts",
	"tests/web-attachment-download-sink.chromium.test.ts",
	"tests/opfs-upload-spool.chromium.test.ts",
];
const selectors = new Map([
	["binary-transfer", ["tests/web-binary-transfer.chromium.test.ts"]],
	[
		"attachment-download-sink",
		["tests/web-attachment-download-sink.chromium.test.ts"],
	],
]);
const requestedSelector = process.argv.slice(2);
const suites =
	requestedSelector.length === 0
		? allSuites
		: requestedSelector.length === 1
			? selectors.get(requestedSelector[0])
			: undefined;

if (suites === undefined) {
	console.error(
		"Usage: node ./scripts/test-chromium.mjs [binary-transfer|attachment-download-sink]",
	);
	process.exit(2);
}

for (const suite of suites) {
	const result = spawnSync(
		"xvfb-run",
		[
			"--auto-servernum",
			"--server-args=-screen 0 1280x1024x24",
			"bun",
			"test",
			suite,
		],
		{ stdio: "inherit" },
	);
	if (result.error?.code === "ENOENT") {
		console.error(
			"xvfb-run is required for the client Runtime Chromium acceptance gate; install Xvfb and retry.",
		);
		process.exit(1);
	}
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
