import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("prepare release passes the release type directly to the pnpm script", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/prepare-release.yml", import.meta.url),
		"utf8",
	);

	assert.match(workflow, /pnpm run version:next "\$RELEASE_TYPE"/);
	assert.match(workflow, /gh workflow run ci\.yml --ref "\$branch"/);
});

test("web E2E runs for releases and scheduled or manual verification", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	);

	assert.match(
		workflow,
		/web-e2e-run:\n(?:.|\n)*?if: >-\n\s+github\.event_name == 'schedule' \|\|\n\s+github\.event_name == 'workflow_dispatch' \|\|\n\s+\(github\.event_name == 'pull_request' && startsWith\(github\.head_ref, 'release\/v'\)\)/,
	);
	assert.match(
		workflow,
		/E2E_REQUIRED: >-\n\s+\$\{\{ github\.event_name == 'schedule' \|\|\n\s+github\.event_name == 'workflow_dispatch' \|\|\n\s+\(github\.event_name == 'pull_request' && startsWith\(github\.head_ref, 'release\/v'\)\) \}\}/,
	);
});
