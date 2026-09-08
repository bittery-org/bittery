import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	auditTransitionalReachability,
	describeAudit,
	FORBIDDEN_KINDS,
	TRANSITIONAL_SURFACE,
} from "./transitional-reachability";
import { buildWebImportGraph, WEB_ENTRIES } from "./web-import-graph";

const graph = buildWebImportGraph();
const audit = auditTransitionalReachability(graph);

describe("the Web entry graph", () => {
	test("sees every statically named runtime-loading import form", () => {
		const fixture = buildWebImportGraph([
			resolve(
				import.meta.dirname,
				"fixtures/web-import-graph/static-forms.fixture.txt",
			),
		]);

		expect(
			fixture.imports.map(({ module, symbol }) => `${module} ${symbol}`),
		).toEqual([
			"@bittery/core/services/account-lifecycle *",
			"@fixture/dynamic-import *",
			"@fixture/import-equals *",
			"@fixture/static-require *",
			"@fixture/type-only-reexport *",
		]);
	});

	test("reaches the whole app, lazy routes included", () => {
		expect(graph.files.length).toBeGreaterThan(80);
		expect(graph.files).toContain("src/router.tsx");
		// A `.lazy` route is only ever reached through `import()`. The audit that this
		// replaces read a file list and missed exactly this one.
		expect(graph.files).toContain("src/routes/_app/security.lazy.tsx");
		expect(graph.files).toContain("src/routes/_app/vaults/trash.tsx");
		expect(graph.files).toContain("src/routes/_app/home.tsx");
		// A stylesheet resolves to a real file and executes nothing.
		expect(graph.files).not.toContain("src/index.css");
	});

	test("starts where the browser starts", () => {
		expect(WEB_ENTRIES.some((entry) => entry.endsWith("router.tsx"))).toBe(
			true,
		);
		expect(
			WEB_ENTRIES.some((entry) => entry.endsWith("routeTree.gen.ts")),
		).toBe(true);
	});

	test("includes the production Runtime Worker reached through its bundler URL", () => {
		expect(graph.files).toContain("src/lib/runtime.worker.ts");
	});

	test("follows shared workspace bridges before classifying transitional owners", () => {
		expect(graph.files).toContain("../../packages/ui/src/index.ts");
		expect(graph.files).toContain(
			"../../packages/client-runtime/src/client/index.ts",
		);
	});

	test("forbids Item writers behind every supported static loading form", () => {
		for (const name of [
			"named-alias",
			"namespace",
			"namespace-reexport",
			"reexport-entry",
			"dynamic",
			"require",
			"import-equals",
			"side-effect",
			"type-specifier",
			"worker-entry",
			"relative-owner",
			"root-owner",
		]) {
			const fixture = buildWebImportGraph([
				resolve(import.meta.dirname, `fixtures/item-write/${name}.fixture.txt`),
			]);
			expect(describeAudit(auditTransitionalReachability(fixture))).not.toBe(
				"",
			);
		}
	});

	test("an erased local type import does not execute its owner's value imports", () => {
		const fixture = buildWebImportGraph([
			resolve(
				import.meta.dirname,
				"fixtures/item-write/type-only-entry.fixture.txt",
			),
		]);
		expect(describeAudit(auditTransitionalReachability(fixture))).toBe("");
	});

	test("counts a type-only import as reaching nothing", () => {
		const typeOnly = graph.imports.filter(
			(imported) =>
				imported.module === "@bittery/core/hooks" &&
				imported.symbol === "UnifiedItem",
		);
		expect(typeOnly).toEqual([]);
	});
});

describe("what the Web may still reach in the transitional stack", () => {
	test("no Web entry reaches the transitional account lifecycle owner", () => {
		const lifecycleImports = graph.imports
			.filter(
				(imported) =>
					imported.module === "@bittery/core/services/account-lifecycle",
			)
			.map((imported) => `${imported.symbol} ${imported.file}`);

		expect(lifecycleImports).toEqual([]);
	});

	test("no read path and no create path reaches a transitional owner", () => {
		expect(describeAudit(audit)).toBe("");
		expect(audit.violations).toEqual([]);
	});

	test("every transitional symbol the Web reaches is classified", () => {
		expect(audit.unclassified).toEqual([]);
	});

	test("no recorded holdout has outlived its reason", () => {
		expect(audit.staleHoldouts).toEqual([]);
	});

	test("the transitional Sync loop is unreachable from Web", () => {
		const syncLoop = audit.reached.filter((item) => item.kind === "sync-loop");
		expect(syncLoop).toEqual([]);
	});

	test("the Runtime is the only Items and Vault reader the Web has", () => {
		const reads = audit.reached.filter(
			(item) => item.kind === "item-read" || item.kind === "vault-read",
		);
		expect(reads).toEqual([]);
	});
});

describe("the final Web Item cutover", () => {
	test("no Web entry reaches a transitional Item writer", () => {
		expect(FORBIDDEN_KINDS.has("item-write")).toBe(true);
		const writes = audit.reached
			.filter((item) => item.kind === "item-write")
			.map((item) => item.symbol);
		expect([...new Set(writes)].sort()).toEqual([]);
	});

	test("Share creation cannot reach its retired transitional writer", () => {
		expect(FORBIDDEN_KINDS.has("share-write")).toBe(true);
		const writes = audit.reached.filter((item) => item.kind === "share-write");
		expect(writes).toEqual([]);
	});

	test("Vault creation is Runtime-owned while later Vault writes remain transitional", () => {
		expect(FORBIDDEN_KINDS.has("vault-create")).toBe(true);
		expect(
			audit.reached.filter((item) => item.kind === "vault-create"),
		).toEqual([]);
		expect(FORBIDDEN_KINDS.has("vault-write")).toBe(false);
		const writes = audit.reached
			.filter((item) => item.kind === "vault-write")
			.map((item) => item.symbol);
		expect([...new Set(writes)].sort()).toEqual([
			"useConvertVaultType",
			"useDeleteVault",
			"useUpdateVault",
		]);
	});

	test("a classification stays after its last consumer goes", () => {
		// `useItems` has no consumer left. Keeping the row means re-adding one fails the
		// audit instead of quietly needing the table extended first.
		const useItems = TRANSITIONAL_SURFACE.find(
			(entry) => entry.symbol === "useItems",
		);
		expect(useItems?.kind).toBe("item-read");
		expect(audit.reached.some((item) => item.symbol === "useItems")).toBe(
			false,
		);
	});
});
