import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import {
	buildRepositoryImportGraph,
	calledMemberFiles,
	repositoryProductionEntries,
} from "./web-import-graph";

const root = resolve(import.meta.dirname, "../../..");
const graph = buildRepositoryImportGraph();

/** Inspect references too: aliasing/destructuring an HTTP importer cannot hide its owner. */
function importReferences(files: readonly string[]) {
	const references: string[] = [];
	for (const file of files) {
		const source = ts.createSourceFile(
			file,
			readFileSync(resolve(root, file), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node: ts.Node) => {
			if (
				ts.isPropertyAccessExpression(node) &&
				node.name.text === "importItems"
			)
				references.push(`${file}:${node.expression.getText(source)}`);
			if (
				ts.isElementAccessExpression(node) &&
				ts.isStringLiteral(node.argumentExpression) &&
				node.argumentExpression.text === "importItems"
			)
				references.push(`${file}:${node.expression.getText(source)}`);
			if (
				ts.isBindingElement(node) &&
				(node.propertyName ?? node.name).getText(source) === "importItems"
			)
				references.push(`${file}:destructured`);
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return references.sort();
}

describe("the executable whole-repository Import ownership graph", () => {
	test("all production hosts and shared entries reach only the Runtime Import caller", () => {
		expect(repositoryProductionEntries().length).toBeGreaterThan(20);
		expect(graph.files).toContain("apps/desktop/src/main.tsx");
		expect(graph.files).toContain("apps/extension/src/background/index.ts");
		expect(graph.files).toContain("apps/mobile/src/main.tsx");
		expect(calledMemberFiles(graph, "importItems")).toEqual([
			"apps/web/src/hooks/use-vault-import.ts",
		]);
		expect(importReferences(graph.files)).toEqual([
			"apps/web/src/hooks/use-vault-import.ts:runtimeClient",
		]);
	});
	test("the presentation hook has no transitional Import crypto, storage, HTTP or cache owner", () => {
		const source = readFileSync(
			resolve(root, "apps/web/src/hooks/use-vault-import.ts"),
			"utf8",
		);
		for (const retired of [
			"getClientForAccount",
			"usePlatformCrypto",
			"useCoreContext",
			"vaultCrypto",
			"itemCache",
			"runtimeImportParking",
			"useQueryInvalidator",
			"refreshFromServer",
		])
			expect(source).not.toContain(retired);
		for (const retired of [
			"apps/web/src/hooks/runtime-import-parking.ts",
			"apps/web/src/lib/runtime-import-lifecycle.ts",
		]) {
			expect(existsSync(resolve(root, retired))).toBe(false);
			expect(graph.files).not.toContain(retired);
		}
		expect(source).toContain("useRuntimeOperations");
	});
});
