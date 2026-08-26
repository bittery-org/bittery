import { describe, expect, test } from "bun:test";
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
		// Only the recorded holdouts survive, and each one exists to serve a write kind
		// ticket 28 has not moved yet.
		expect(reads.map((item) => `${item.symbol} ${item.file}`).sort()).toEqual([
			"useAllVaultKeys src/hooks/use-vault-import.ts",
			"useDeletedItems src/routes/_app/vaults/trash.tsx",
			"useItemAttachments src/components/vault/item-detail-pane.tsx",
			"useMoveTargetVaults src/components/vault/move-item-dialog.tsx",
		]);
	});
});

describe("what this audit deliberately does not assert yet", () => {
	test("the remaining Item write kinds are still transitional", () => {
		// Ticket 22's maintainer decision: update, delete, favorite, move and share keep
		// writing to the transitional repository until ticket 28 ports them, and gating
		// them in the meantime would be throwaway work. Ticket 28 tightens the audit by
		// adding "item-write" here and deleting the call sites this lists.
		expect(FORBIDDEN_KINDS.has("item-write")).toBe(false);
		const writes = audit.reached
			.filter((item) => item.kind === "item-write")
			.map((item) => item.symbol);
		expect([...new Set(writes)].sort()).toEqual([
			"useDeleteItem",
			"useMoveItem",
			"usePermanentDeleteItem",
			"useRestoreItem",
			"useToggleFavorite",
			"useUpdateItem",
		]);
	});

	test("Share creation cannot reach its retired transitional writer", () => {
		expect(FORBIDDEN_KINDS.has("share-write")).toBe(true);
		const writes = audit.reached.filter((item) => item.kind === "share-write");
		expect(writes).toEqual([]);
	});

	test("Vault create, update, delete and conversion are still transitional", () => {
		expect(FORBIDDEN_KINDS.has("vault-write")).toBe(false);
		const writes = audit.reached
			.filter((item) => item.kind === "vault-write")
			.map((item) => item.symbol);
		expect([...new Set(writes)].sort()).toEqual([
			"useConvertVaultType",
			"useCreateVault",
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
