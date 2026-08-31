import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const allSuites = [
	"tests/web-account-lease.chromium.test.ts",
	"tests/web-binary-transfer.chromium.test.ts",
	"tests/web-attachment-download-sink.chromium.test.ts",
	"tests/web-attachment-upload.chromium.test.ts",
	"tests/opfs-upload-spool.chromium.test.ts",
	"tests/web-vault-image-artifact.chromium.test.ts",
];
const selectors = new Map([
	["binary-transfer", ["tests/web-binary-transfer.chromium.test.ts"]],
	[
		"attachment-download-sink",
		["tests/web-attachment-download-sink.chromium.test.ts"],
	],
	["attachment-upload", ["tests/web-attachment-upload.chromium.test.ts"]],
	["vault-image-artifact", ["tests/web-vault-image-artifact.chromium.test.ts"]],
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
		"Usage: node ./scripts/test-chromium.mjs [binary-transfer|attachment-download-sink|attachment-upload|vault-image-artifact]",
	);
	process.exit(2);
}

const xvfbAvailable = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((directory) => directory.length > 0)
	.some((directory) => {
		try {
			accessSync(join(directory, "xvfb-run"), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
if (!xvfbAvailable) {
	console.error(
		"xvfb-run is required for the client Runtime Chromium acceptance gate; install Xvfb and retry.",
	);
	process.exit(1);
}

let joinedUploadBindingsRoot;
if (suites.includes("tests/web-attachment-upload.chromium.test.ts")) {
	joinedUploadBindingsRoot = mkdtempSync(
		join(process.env.TMPDIR ?? tmpdir(), "bittery-joined-upload-bindings."),
	);
	const built = spawnSync(
		"./scripts/build-web-bindings.sh",
		[joinedUploadBindingsRoot],
		{
			stdio: "inherit",
			env: { ...process.env, BITTERY_BINDING_TEST_HARNESS: "1" },
		},
	);
	if (built.error) throw built.error;
	if (built.status !== 0) {
		rmSync(joinedUploadBindingsRoot, { recursive: true, force: true });
		process.exit(built.status ?? 1);
	}
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
		{
			stdio: "inherit",
			env: {
				...process.env,
				...(joinedUploadBindingsRoot === undefined
					? {}
					: {
							BITTERY_JOINED_UPLOAD_BINDINGS_ROOT: joinedUploadBindingsRoot,
						}),
			},
		},
	);
	if (result.error?.code === "ENOENT") {
		console.error(
			"xvfb-run is required for the client Runtime Chromium acceptance gate; install Xvfb and retry.",
		);
		process.exit(1);
	}
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (joinedUploadBindingsRoot !== undefined)
			rmSync(joinedUploadBindingsRoot, { recursive: true, force: true });
		process.exit(result.status ?? 1);
	}
}

if (joinedUploadBindingsRoot !== undefined)
	rmSync(joinedUploadBindingsRoot, { recursive: true, force: true });
