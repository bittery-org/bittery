import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("prepare release passes the release type directly to the pnpm script", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/prepare-release.yml", import.meta.url),
		"utf8",
	);

	assert.match(workflow, /pnpm run version:next "\$RELEASE_TYPE"/);
});
