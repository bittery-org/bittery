import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
	auditLegacyCreateVaultSymbols,
	buildRepositoryImportGraph,
	calledMemberFiles,
	classMethodFiles,
	extensionProductionEntries,
	repositoryProductionEntries,
} from "./web-import-graph";

const repository = resolve(import.meta.dirname, "../../..");
const graph = buildRepositoryImportGraph();

function testSources(directory: string): string[] {
	if (!statSync(directory).isDirectory()) return [directory];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			return ["node_modules", "target", "dist", ".turbo", "generated"].includes(
				entry.name,
			)
				? []
				: testSources(path);
		}
		return /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
	});
}

describe("the executable whole-repository create-Vault graph", () => {
	test("starts at every host and workspace package production interface", () => {
		const entries = repositoryProductionEntries().map((file) =>
			relative(repository, file),
		);
		for (const entry of [
			"apps/web/src/router.tsx",
			"apps/desktop/src/main.tsx",
			"apps/mobile/src/main.tsx",
			"apps/extension/src/background/index.ts",
			"apps/extension/src/content.ts",
			"apps/extension/src/popup.tsx",
			"packages/core/src/services/vault-service.ts",
		]) {
			expect(entries).toContain(entry);
		}
	});

	test("derives every Extension page, worker, and content entry from its manifest and HTML", () => {
		const entries = extensionProductionEntries().map((file) =>
			relative(repository, file),
		);
		expect(entries).toEqual(
			expect.arrayContaining([
				"apps/extension/src/background/index.ts",
				"apps/extension/src/content.ts",
				"apps/extension/src/page-script/passkey.ts",
				"apps/extension/src/content-script/passkey-bridge-entry.ts",
				"apps/extension/src/popup.tsx",
				"apps/extension/src/autofill-iframe.tsx",
				"apps/extension/src/credit-card-autofill-iframe.tsx",
				"apps/extension/src/identity-autofill-iframe.tsx",
				"apps/extension/src/passkey-picker-iframe.tsx",
				"apps/extension/src/passkey-save-target-iframe.tsx",
				"apps/extension/src/save-prompt-iframe.tsx",
			]),
		);
	});

	test("a legacy alias reachable only from an Extension popup page fails the audit", () => {
		const fixtureRoot = resolve(
			import.meta.dirname,
			"fixtures/create-vault/extension-popup",
		);
		const entries = extensionProductionEntries(fixtureRoot);
		const fixtureGraph = buildRepositoryImportGraph(entries);
		expect(
			auditLegacyCreateVaultSymbols(entries, fixtureGraph).files,
		).toContain(
			"apps/web/scripts/fixtures/create-vault/extension-popup/popup-entry.fixture.txt",
		);
	});

	test("follows production re-exports, side effects, CJS and lazy imports", () => {
		expect(graph.files).toContain("apps/web/src/routes/_app/security.lazy.tsx");
		expect(graph.files).toContain("apps/extension/src/background/index.ts");
		expect(graph.files).toContain(
			"packages/core/src/services/vault-service.ts",
		);
		expect(graph.files.length).toBeGreaterThan(400);
	});

	test("the retired Core writer is absent and native hosts have no create caller", () => {
		expect(
			auditLegacyCreateVaultSymbols(repositoryProductionEntries(), graph).files,
		).toEqual([]);
		expect(classMethodFiles(graph, "VaultService", "createVault")).toEqual([]);
		const hostCallers = calledMemberFiles(graph, "createVault").filter((file) =>
			/^apps\/(?:web|desktop|mobile|extension)\//.test(file),
		);
		expect(
			hostCallers.filter((file) =>
				/^apps\/(?:desktop|mobile|extension)\//.test(file),
			),
		).toEqual([]);
		expect(hostCallers.sort()).toEqual([
			"apps/web/src/hooks/use-vault-import.ts",
		]);
	}, 20_000);

	test("symbol-aware audit rejects native hook, aliased writer, destructuring, and nested multiline re-exports", () => {
		const fixture = (name: string) =>
			resolve(import.meta.dirname, `fixtures/create-vault/${name}.fixture.txt`);
		for (const [entry, expected] of [
			["native-hook", "native-hook.fixture.txt"],
			["writer", "writer.fixture.txt"],
			["reexport-entry", "reexport-entry.fixture.txt"],
			["cjs-entry", "cjs-entry.fixture.txt"],
			["dynamic-entry", "dynamic-entry.fixture.txt"],
			["namespace-entry", "namespace-entry.fixture.txt"],
			["side-effect-entry", "side-effect-entry.fixture.txt"],
		] as const) {
			expect(auditLegacyCreateVaultSymbols([fixture(entry)]).files).toContain(
				`apps/web/scripts/fixtures/create-vault/${expected}`,
			);
		}
	});

	test("spec and fixture callers cannot keep the deleted VaultService writer alive", () => {
		const tests = ["apps", "packages"].flatMap((root) =>
			testSources(resolve(repository, root)),
		);
		const testGraph = buildRepositoryImportGraph(tests);
		expect(auditLegacyCreateVaultSymbols(tests, testGraph).files).toEqual([]);
		expect(classMethodFiles(testGraph, "VaultService", "createVault")).toEqual(
			[],
		);
		expect(
			testGraph.files.some(
				(file) => file === "apps/web/tests/e2e/runtime-attachment-move.spec.ts",
			),
		).toBe(true);
	}, 20_000);
});
