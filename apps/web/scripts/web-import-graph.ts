/**
 * The Web module graph, as the browser bundle actually reaches it.
 *
 * Written for the cutover audit in `transitional-reachability.ts`: the question "does any
 * Web path still reach the transitional owner" can only be answered over the whole entry
 * graph. A hand-picked file list answers a different question and answered it wrongly once
 * already — it reported the Items migration complete while three consumers remained.
 *
 * The graph is parsed with the TypeScript compiler, not with a regular expression, because
 * an import clause spans lines, carries `type` markers, and appears again as a dynamic
 * `import()` for every lazy route. A regular expression gets those wrong quietly.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";

/** Repository-relative root of the Web app. */
export const APP_ROOT = resolve(import.meta.dirname, "..");
const SRC_ROOT = join(APP_ROOT, "src");

/**
 * Where the browser bundle starts.
 *
 * `router.tsx` is the composition root. `routeTree.gen.ts` is the generated route tree; it
 * reaches every eager route by import and every lazy route by `import()`, so both forms have
 * to be followed or a `.lazy` route hides from the audit.
 */
export const WEB_ENTRIES = [
	join(SRC_ROOT, "router.tsx"),
	join(SRC_ROOT, "routeTree.gen.ts"),
] as const;

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;

/** One value import of one external module by one Web file. */
export interface ExternalImport {
	/** The bare module specifier, for example `@bittery/core/hooks`. */
	readonly module: string;
	/** The exported name, `default` for a default import, `*` for a namespace or `import()`. */
	readonly symbol: string;
	/** The importing file, relative to `apps/web`. */
	readonly file: string;
}

export interface WebImportGraph {
	/** Every Web file the entries reach, relative to `apps/web`. */
	readonly files: readonly string[];
	/** Every value import of an external module from those files. */
	readonly imports: readonly ExternalImport[];
}

function resolveWebModule(specifier: string, from: string): string | null {
	let base: string;
	if (specifier.startsWith("@/")) base = join(SRC_ROOT, specifier.slice(2));
	else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
	else return null;
	// Only a module the bundle executes counts. A stylesheet import resolves to a real
	// file and reaches nothing, so following it would only pad the graph.
	for (const extension of EXTENSIONS) {
		const candidate = base.endsWith(extension) ? base : base + extension;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	for (const extension of EXTENSIONS) {
		const candidate = join(base, `index${extension}`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

interface Edge {
	readonly specifier: string;
	readonly symbols: readonly string[];
}

/**
 * The value imports of one file.
 *
 * A declaration-level `import type` is dropped because it is erased completely. Under this
 * app's `verbatimModuleSyntax`, a value declaration containing only per-specifier `type`
 * markers emits an empty side-effect import, so it is conservatively recorded as `*`.
 *
 * ESM imports/re-exports and literal dynamic `import()` are the production forms. Literal
 * import-equals and `require()` are classified conservatively too: the current browser build
 * rejects CommonJS-shaped source, but the audit should fail closed before relying on that.
 * A runtime-computed specifier cannot be resolved to an owner statically and is deliberately
 * outside this graph.
 */
function readEdges(file: string): Edge[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const edges: Edge[] = [];
	const staticSpecifier = (expression: ts.Expression): string | null =>
		ts.isStringLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression)
			? expression.text
			: null;
	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const symbols: string[] = [];
			const clause = node.importClause;
			if (clause === undefined) {
				symbols.push("*");
			} else if (!clause.isTypeOnly) {
				if (clause.name) symbols.push("default");
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) symbols.push("*");
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						if (element.isTypeOnly) continue;
						symbols.push((element.propertyName ?? element.name).text);
					}
				}
				// With `verbatimModuleSyntax`, `import { type X } from "owner"`
				// becomes `import {} from "owner"` and still executes the owner.
				if (symbols.length === 0) symbols.push("*");
			}
			edges.push({ specifier: node.moduleSpecifier.text, symbols });
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			!node.isTypeOnly &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression
		) {
			const specifier = staticSpecifier(node.moduleReference.expression);
			if (specifier !== null) edges.push({ specifier, symbols: ["*"] });
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const symbols: string[] = [];
			if (!node.isTypeOnly) {
				const clause = node.exportClause;
				if (clause && ts.isNamedExports(clause)) {
					for (const element of clause.elements) {
						if (element.isTypeOnly) continue;
						symbols.push((element.propertyName ?? element.name).text);
					}
				}
				if (!clause || symbols.length === 0) symbols.push("*");
			}
			edges.push({ specifier: node.moduleSpecifier.text, symbols });
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		) {
			const argument = node.arguments[0];
			if (argument) {
				const specifier = staticSpecifier(argument);
				if (specifier !== null) edges.push({ specifier, symbols: ["*"] });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return edges;
}

/** Walk every Web file the entries reach and collect their external value imports. */
export function buildWebImportGraph(
	entries: readonly string[] = WEB_ENTRIES,
): WebImportGraph {
	const visited = new Set<string>();
	const imports: ExternalImport[] = [];
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		for (const edge of readEdges(file)) {
			const local = resolveWebModule(edge.specifier, file);
			if (local !== null) {
				queue.push(local);
				continue;
			}
			for (const symbol of edge.symbols) {
				imports.push({
					module: edge.specifier,
					symbol,
					file: relative(APP_ROOT, file),
				});
			}
		}
	}
	return {
		files: [...visited].map((file) => relative(APP_ROOT, file)).sort(),
		imports: imports.sort(
			(left, right) =>
				left.module.localeCompare(right.module) ||
				left.symbol.localeCompare(right.symbol) ||
				left.file.localeCompare(right.file),
		),
	};
}
