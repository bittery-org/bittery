import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const webRoot = path.resolve(import.meta.dirname, "..");

function source(relativePath: string): ts.SourceFile {
	const filePath = path.join(webRoot, relativePath);
	return ts.createSourceFile(
		filePath,
		readFileSync(filePath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function importedLocalName(
	file: ts.SourceFile,
	moduleName: string,
	importedName: string,
): string | null {
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== moduleName
		)
			continue;
		for (const element of statement.importClause?.namedBindings &&
		ts.isNamedImports(statement.importClause.namedBindings)
			? statement.importClause.namedBindings.elements
			: []) {
			if ((element.propertyName ?? element.name).text === importedName)
				return element.name.text;
		}
	}
	return null;
}

function hasCall(file: ts.SourceFile, object: string, method: string): boolean {
	let found = false;
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === object &&
			node.expression.name.text === method
		)
			found = true;
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

describe("Runtime Import parking production source wiring contract (not runtime behavior)", () => {
	test("scoped and global retirement clear each decrypted draft before unlinking its generation", () => {
		const parking = readFileSync(
			path.join(webRoot, "src/hooks/runtime-import-parking.ts"),
			"utf8",
		);
		const scopedStart = parking.indexOf("\n\t\tretire(accountId) {");
		const globalStart = parking.indexOf("\n\t\tretireAll() {");
		expect(scopedStart).toBeGreaterThan(-1);
		expect(globalStart).toBeGreaterThan(scopedStart);
		const scoped = parking.slice(scopedStart, globalStart);
		expect(scoped.indexOf("generation.draft = null")).toBeGreaterThan(-1);
		expect(scoped.indexOf("generation.draft = null")).toBeLessThan(
			scoped.indexOf("generationsByAccountId.delete(accountId)"),
		);
		const global = parking.slice(
			globalStart,
			parking.indexOf("\n\t\tsubscribe(", globalStart),
		);
		expect(global.indexOf("generation.draft = null")).toBeGreaterThan(-1);
		expect(global.indexOf("generation.draft = null")).toBeLessThan(
			global.indexOf("generationsByAccountId.clear()"),
		);
	});

	test("the Web singleton, router, and account-deletion recovery share the lifecycle-composed client", () => {
		const singleton = source("src/lib/web-runtime-client.ts");
		const rawClient = importedLocalName(singleton, "./crypto", "runtimeClient");
		const lifecycle = importedLocalName(
			singleton,
			"./runtime-import-lifecycle",
			"withRuntimeImportParkingLifecycle",
		);
		expect(rawClient).toBe("runtimeClient");
		expect(lifecycle).toBe("withRuntimeImportParkingLifecycle");

		const declaration = singleton.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => [...statement.declarationList.declarations])
			.find(
				(candidate) =>
					ts.isIdentifier(candidate.name) &&
					candidate.name.text === "webRuntimeClient",
			);
		const initializer = declaration?.initializer;
		const wrappedClient =
			initializer && ts.isCallExpression(initializer)
				? initializer.arguments[0]
				: undefined;
		expect(
			initializer &&
				ts.isCallExpression(initializer) &&
				ts.isIdentifier(initializer.expression) &&
				initializer.expression.text === lifecycle &&
				initializer.arguments.length === 1 &&
				wrappedClient !== undefined &&
				ts.isIdentifier(wrappedClient) &&
				wrappedClient.text === rawClient,
		).toBe(true);

		const router = source("src/router.tsx");
		const routerClient = importedLocalName(
			router,
			"./lib/web-runtime-client",
			"webRuntimeClient",
		);
		expect(routerClient).toBe("runtimeClient");
		let providerUsesClient = false;
		function visitRouter(node: ts.Node): void {
			if (
				ts.isJsxOpeningElement(node) &&
				node.tagName.getText(router) === "RuntimeProvider"
			) {
				const client = node.attributes.properties.find(
					(attribute): attribute is ts.JsxAttribute =>
						ts.isJsxAttribute(attribute) &&
						attribute.name.getText(router) === "client",
				);
				providerUsesClient =
					client?.initializer !== undefined &&
					ts.isJsxExpression(client.initializer) &&
					client.initializer.expression !== undefined &&
					ts.isIdentifier(client.initializer.expression) &&
					client.initializer.expression.text === routerClient;
			}
			ts.forEachChild(node, visitRouter);
		}
		visitRouter(router);
		expect(providerUsesClient).toBe(true);

		const recovery = source("src/lib/account-deletion-recovery.ts");
		const recoveryClient = importedLocalName(
			recovery,
			"./web-runtime-client",
			"webRuntimeClient",
		);
		expect(recoveryClient).toBe("runtimeClient");
		if (recoveryClient === null)
			throw new Error("Account-deletion recovery has no Web Runtime client");
		expect(hasCall(recovery, recoveryClient, "removeAccount")).toBe(true);
		expect(hasCall(recovery, recoveryClient, "deleteServerAccount")).toBe(true);
	});
});
