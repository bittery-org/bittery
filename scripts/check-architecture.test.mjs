import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	checkArchitecture,
	classifyImport,
	extractImportSpecifiers,
	findViolation,
} from "./check-architecture.mjs";

test("extracts supported imports without matching comments or ordinary strings", () => {
	const source = `
		// import "ignored-comment";
		/* export * from "ignored-block-comment"; */
		const text = 'import "ignored-string"';
		import value from "@bittery/core";
		import "@bittery/i18n";
		export { thing } from "../shared/src/thing";
		export * from '@bittery/types';
		const lazy = import(\`@bittery/sync\`);
		const configured = import("@bittery/device", { with: { type: "json" } });
		const rejected = import(\`ignored-\${name}\`);
		const interpolated = \`ignored-\${import("@bittery/storage")}\`;
		const legacy = require("../../apps/web/src/config"); // require("ignored")
		object.require("ignored-property");
	`;

	assert.deepEqual(extractImportSpecifiers(source), [
		"@bittery/core",
		"@bittery/i18n",
		"../shared/src/thing",
		"@bittery/types",
		"@bittery/sync",
		"@bittery/device",
		"@bittery/storage",
		"../../apps/web/src/config",
	]);
});

test("classifies workspace aliases and relative imports outside a package", () => {
	const packageOwners = [
		{ name: "ui", root: "/repo/packages/ui" },
		{ name: "core", root: "/repo/packages/core" },
	];
	assert.equal(
		classifyImport(
			"/repo/packages/ui/src/button.tsx",
			"@bittery/core/hooks",
			"/repo",
		),
		"core",
	);
	assert.equal(
		classifyImport(
			"/repo/packages/ui/src/button.tsx",
			"../../core/src/index.ts",
			"/repo",
			packageOwners,
		),
		"core",
	);
	assert.equal(
		classifyImport(
			"/repo/packages/core/src/service.ts",
			"../../../apps/web/src/config.ts",
			"/repo",
		),
		"apps",
	);
	assert.equal(
		classifyImport(
			"/repo/packages/core/src/service.ts",
			"./local.ts",
			"/repo",
			packageOwners,
		),
		"core",
	);
});

test("nested workspace packages cannot escape into apps", async (context) => {
	const repositoryRoot = await mkdtemp(
		path.join(tmpdir(), "bittery-architecture-"),
	);
	context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
	const packageRoot = path.join(repositoryRoot, "packages/crypto/core");
	await mkdir(packageRoot, { recursive: true });
	await mkdir(path.join(repositoryRoot, "apps/web/src"), { recursive: true });
	await writeFile(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: "@bittery/crypto-core" }),
	);
	await writeFile(
		path.join(packageRoot, "index.ts"),
		'import "../../../apps/web/src/config.ts";',
	);

	assert.deepEqual(await checkArchitecture(repositoryRoot), [
		"packages/crypto/core/index.ts imports ../../../apps/web/src/config.ts: packages cannot import apps",
	]);
});

test("enforces package dependency direction", () => {
	assert.match(
		findViolation("ui", "core"),
		/@bittery\/ui cannot import @bittery\/core/,
	);
	assert.match(findViolation("core", "apps"), /packages cannot import apps/);
	assert.match(
		findViolation("sync", "storage"),
		/@bittery\/sync cannot import @bittery\/storage/,
	);
	assert.equal(findViolation("sync", "types"), null);
	assert.equal(findViolation("shared", "api-contract"), null);
	assert.equal(findViolation("types", "api-contract"), null);
	assert.match(
		findViolation("types", "shared"),
		/@bittery\/types may only import @bittery\/api-contract/,
	);
});
