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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Classify these ownership boundaries by imported symbol; follow other workspace bridges. */
export const TRANSITIONAL_MODULE_PREFIXES = [
	"@bittery/core",
	"@bittery/storage",
	"@bittery/sync",
] as const;

const EXTENSIONS = [
	".fixture.txt",
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
] as const;

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
	/** Every Web or shared source the entries reach, relative to `apps/web`. */
	readonly files: readonly string[];
	/** Every value import of an external module from those files. */
	readonly imports: readonly ExternalImport[];
}

function parseTypeScriptFile(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function resolveWebModule(specifier: string, from: string): string | null {
	let base: string;
	if (specifier.startsWith("@/")) base = join(SRC_ROOT, specifier.slice(2));
	else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
	else {
		return TRANSITIONAL_MODULE_PREFIXES.some((prefix) =>
			specifier.startsWith(prefix),
		)
			? null
			: resolveWorkspaceExport(specifier, workspacePackages());
	}
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

/** Relative source imports cannot bypass a package's classified ownership boundary. */
function transitionalBoundary(specifier: string, from: string): string | null {
	if (
		TRANSITIONAL_MODULE_PREFIXES.some((prefix) => specifier.startsWith(prefix))
	)
		return specifier;
	if (!specifier.startsWith(".")) return null;
	const target = resolveSource(resolve(dirname(from), specifier));
	if (target === null) return null;
	for (const workspace of workspacePackages()) {
		if (!TRANSITIONAL_MODULE_PREFIXES.some((name) => name === workspace.name))
			continue;
		if (!target.startsWith(`${workspace.root}/`)) continue;
		for (const [subpath, exported] of workspace.exports) {
			if (resolve(workspace.root, exported) === target)
				return workspace.name + (subpath === "." ? "" : subpath.slice(1));
		}
		// Private implementation imports fail as unclassified rather than silently
		// escaping the public-symbol audit.
		return `${workspace.name}/${relative(workspace.root, target)}`;
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
	const source = parseTypeScriptFile(file);
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
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			["Worker", "SharedWorker"].includes(node.expression.text)
		) {
			// Vite recognizes this literal as a separate executable bundle entry.
			const url = node.arguments?.[0];
			if (
				url &&
				ts.isNewExpression(url) &&
				ts.isIdentifier(url.expression) &&
				url.expression.text === "URL" &&
				url.arguments?.[0]
			) {
				const specifier = staticSpecifier(url.arguments[0]);
				if (specifier !== null) edges.push({ specifier, symbols: ["*"] });
			}
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

export interface RepositoryImportGraph {
	/** Every executable source reached from a host or workspace-package production entry. */
	readonly files: readonly string[];
	readonly imports: readonly ExternalImport[];
}

const REPOSITORY_ROOT = resolve(APP_ROOT, "../..");

interface WorkspacePackage {
	readonly name: string;
	readonly root: string;
	readonly exports: ReadonlyMap<string, string>;
}

let cachedWorkspacePackages: readonly WorkspacePackage[] | undefined;

function workspacePackages(): WorkspacePackage[] {
	if (cachedWorkspacePackages !== undefined)
		return [...cachedWorkspacePackages];
	const packagesRoot = join(REPOSITORY_ROOT, "packages");
	const manifests = (directory: string): string[] =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			if (!entry.isDirectory()) return [];
			if (["node_modules", "target", "dist", ".turbo"].includes(entry.name)) {
				return [];
			}
			const root = join(directory, entry.name);
			const manifest = join(root, "package.json");
			return existsSync(manifest) ? [manifest] : manifests(root);
		});
	const discovered = manifests(packagesRoot).flatMap((manifestPath) => {
		const root = dirname(manifestPath);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			name?: string;
			main?: string;
			exports?: Record<string, string | { import?: string; default?: string }>;
		};
		if (!manifest.name) return [];
		const exports = new Map<string, string>();
		if (typeof manifest.exports === "object") {
			for (const [key, value] of Object.entries(manifest.exports)) {
				const target =
					typeof value === "string" ? value : (value.import ?? value.default);
				if (target) exports.set(key, target);
			}
		}
		if (exports.size === 0 && manifest.main) exports.set(".", manifest.main);
		return [{ name: manifest.name, root, exports }];
	});
	cachedWorkspacePackages = discovered;
	return [...discovered];
}

function resolveSource(base: string): string | null {
	for (const extension of EXTENSIONS) {
		const candidate = base.endsWith(extension) ? base : base + extension;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	for (const extension of EXTENSIONS) {
		const candidate = join(base, `index${extension}`);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

const PRODUCTION_HTML_EXCLUDED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	"playwright-report",
	"test-results",
	"tests",
]);

function productionHtmlFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return PRODUCTION_HTML_EXCLUDED_DIRECTORIES.has(entry.name)
				? []
				: productionHtmlFiles(path);
		}
		return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
	});
}

function moduleScriptsFromHtml(html: string, appRoot: string): string[] {
	const source = readFileSync(html, "utf8");
	const entries: string[] = [];
	for (const tag of source.matchAll(/<script\b[^>]*>/gi)) {
		if (!/\btype\s*=\s*["']module["']/i.test(tag[0])) continue;
		const src = tag[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
		if (!src) continue;
		const base = src.startsWith("/")
			? join(appRoot, src.slice(1))
			: resolve(dirname(html), src);
		const entry = resolveSource(base);
		if (entry) entries.push(entry);
	}
	return entries;
}

function configuredEntryReferences(config: string, appRoot: string): string[] {
	if (!existsSync(config)) return [];
	const source = parseTypeScriptFile(config);
	const references: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			/\.(?:html|[cm]?[jt]sx?)$/.test(node.text)
		) {
			const path = resolve(appRoot, node.text.replace(/^\//, ""));
			if (existsSync(path) && statSync(path).isFile()) references.push(path);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return references;
}

/**
 * Extension production entries come from the same manifest, Vite config, and HTML pages that CRX
 * consumes. Root-page discovery is deliberately conservative so a newly added options, side-panel,
 * offscreen, or iframe page cannot disappear from the cutover audit merely because its manifest
 * property was not known to this script.
 */
export function extensionProductionEntries(
	extensionRoot = join(REPOSITORY_ROOT, "apps/extension"),
): string[] {
	const configured = ["manifest.config.js", "vite.config.ts"].flatMap((file) =>
		configuredEntryReferences(join(extensionRoot, file), extensionRoot),
	);
	const html = [
		...productionHtmlFiles(extensionRoot),
		...configured.filter((file) => file.endsWith(".html")),
	];
	const htmlEntries = [...new Set(html)].flatMap((file) =>
		moduleScriptsFromHtml(file, extensionRoot),
	);
	const scriptEntries = configured
		.filter((file) => !file.endsWith(".html"))
		.map((file) => resolveSource(file))
		.filter((file): file is string => file !== null);
	return [...new Set([...scriptEntries, ...htmlEntries])].sort();
}

function resolveWorkspaceExport(
	specifier: string,
	packages: readonly WorkspacePackage[],
): string | null {
	const workspace = packages.find(
		(candidate) =>
			specifier === candidate.name ||
			specifier.startsWith(`${candidate.name}/`),
	);
	if (!workspace) return null;
	const subpath =
		specifier === workspace.name
			? "."
			: `.${specifier.slice(workspace.name.length)}`;
	let target = workspace.exports.get(subpath);
	if (!target) {
		for (const [pattern, candidate] of workspace.exports) {
			if (!pattern.includes("*")) continue;
			const [prefix = "", suffix = ""] = pattern.split("*");
			if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
			const middle = subpath.slice(
				prefix.length,
				subpath.length - suffix.length,
			);
			target = candidate.replace("*", middle);
			break;
		}
	}
	return target ? resolveSource(resolve(workspace.root, target)) : null;
}

function appSourceRoot(file: string): string | null {
	for (const app of ["web", "desktop", "mobile", "extension"]) {
		const root = join(REPOSITORY_ROOT, "apps", app, "src");
		if (file.startsWith(`${root}/`)) return root;
	}
	return null;
}

function resolveRepositoryModule(
	specifier: string,
	from: string,
	packages: readonly WorkspacePackage[],
): string | null {
	if (specifier.startsWith(".")) {
		return resolveSource(resolve(dirname(from), specifier));
	}
	if (specifier.startsWith("@/")) {
		const sourceRoot = appSourceRoot(from);
		return sourceRoot
			? resolveSource(join(sourceRoot, specifier.slice(2)))
			: null;
	}
	return resolveWorkspaceExport(specifier, packages);
}

/** The actual host and package production entries used by Vite/CRX or public exports. */
export function repositoryProductionEntries(): string[] {
	const packages = workspacePackages();
	const hostEntries = [
		"apps/web/src/router.tsx",
		"apps/web/src/routeTree.gen.ts",
		"apps/desktop/src/main.tsx",
		"apps/mobile/src/main.tsx",
	].map((file) => join(REPOSITORY_ROOT, file));
	const packageEntries = packages.flatMap((workspace) =>
		[...workspace.exports.values()]
			.filter(
				(target) => !target.includes("testing") && !target.includes("test"),
			)
			.map((target) => resolveSource(resolve(workspace.root, target)))
			.filter((target): target is string => target !== null),
	);
	return [
		...new Set([
			...hostEntries,
			...extensionProductionEntries(),
			...packageEntries,
		]),
	].filter(existsSync);
}

/** Walk the executable whole-repository production graph through every supported import form. */
export function buildRepositoryImportGraph(
	entries: readonly string[] = repositoryProductionEntries(),
): RepositoryImportGraph {
	const packages = workspacePackages();
	const visited = new Set<string>();
	const imports: ExternalImport[] = [];
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || visited.has(file)) continue;
		visited.add(file);
		for (const edge of readEdges(file)) {
			if (edge.symbols.length === 0) continue;
			const local = resolveRepositoryModule(edge.specifier, file, packages);
			if (local) {
				queue.push(local);
				continue;
			}
			for (const symbol of edge.symbols) {
				imports.push({
					module: edge.specifier,
					symbol,
					file: relative(REPOSITORY_ROOT, file),
				});
			}
		}
	}
	return {
		files: [...visited].map((file) => relative(REPOSITORY_ROOT, file)).sort(),
		imports,
	};
}

/** AST-backed call sites; used by cutover gates after reachability has selected the files. */
export function calledMemberFiles(
	graph: RepositoryImportGraph,
	member: string,
): string[] {
	return graph.files.filter((relativeFile) => {
		const file = join(REPOSITORY_ROOT, relativeFile);
		const source = parseTypeScriptFile(file);
		let found = false;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				((ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === member) ||
					(ts.isIdentifier(node.expression) && node.expression.text === member))
			) {
				found = true;
			}
			if (!found) ts.forEachChild(node, visit);
		};
		visit(source);
		return found;
	});
}

export function classMethodFiles(
	graph: RepositoryImportGraph,
	className: string,
	methodName: string,
): string[] {
	return graph.files.filter((relativeFile) => {
		const file = join(REPOSITORY_ROOT, relativeFile);
		const source = parseTypeScriptFile(file);
		return source.statements.some(
			(statement) =>
				ts.isClassDeclaration(statement) &&
				statement.name?.text === className &&
				statement.members.some(
					(member) =>
						ts.isMethodDeclaration(member) &&
						ts.isIdentifier(member.name) &&
						member.name.text === methodName,
				),
		);
	});
}

export interface LegacyCreateVaultAudit {
	readonly files: readonly string[];
}

/**
 * Resolve the retired create-Vault symbols through the same executable import graph used by the
 * cutover gate. This is intentionally binding-aware: an unrelated Runtime `createVault` member is
 * allowed, while aliases, namespaces, destructuring, and re-export chains of the legacy owners are
 * not.
 */
export function auditLegacyCreateVaultSymbols(
	entries: readonly string[] = repositoryProductionEntries(),
	existingGraph?: RepositoryImportGraph,
): LegacyCreateVaultAudit {
	const graph = existingGraph ?? buildRepositoryImportGraph(entries);
	const packages = workspacePackages();
	const absoluteFiles = graph.files.map((file) => join(REPOSITORY_ROOT, file));
	const sources = new Map(
		absoluteFiles.map((file) => [file, parseTypeScriptFile(file)]),
	);
	const taintedExports = new Map<string, Set<string>>();
	const taintedLocals = new Map<string, Set<string>>();
	const violations = new Set<string>();
	const exportsFor = (file: string) => {
		let names = taintedExports.get(file);
		if (!names) {
			names = new Set();
			taintedExports.set(file, names);
		}
		return names;
	};
	const localsFor = (file: string) => {
		let names = taintedLocals.get(file);
		if (!names) {
			names = new Set();
			taintedLocals.set(file, names);
		}
		return names;
	};
	const add = (set: Set<string>, name: string): boolean => {
		const before = set.size;
		set.add(name);
		return set.size !== before;
	};
	const resolved = (specifier: string, from: string) =>
		resolveRepositoryModule(specifier, from, packages);
	const legacyExternal = (specifier: string, symbol: string) =>
		(specifier === "@bittery/core/hooks" && symbol === "useCreateVault") ||
		(specifier.includes("use-create-vault") && symbol !== "type") ||
		(specifier.includes("vault-service") && symbol === "VaultService");
	const legacyBinding = (
		specifier: string,
		symbol: string,
		target: string | null,
	) =>
		legacyExternal(specifier, symbol) &&
		(symbol !== "VaultService" || target === null);

	let changed = true;
	while (changed) {
		changed = false;
		for (const [file, source] of sources) {
			const locals = localsFor(file);
			const exported = exportsFor(file);
			const importedModuleTaint = (expression: ts.Expression): boolean => {
				const unwrapped = ts.isAwaitExpression(expression)
					? expression.expression
					: expression;
				if (!ts.isCallExpression(unwrapped) || !unwrapped.arguments[0])
					return false;
				const isModuleCall =
					unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(unwrapped.expression) &&
						unwrapped.expression.text === "require");
				const argument = unwrapped.arguments[0];
				if (!isModuleCall || !ts.isStringLiteral(argument)) return false;
				const target = resolved(argument.text, file);
				return target
					? exportsFor(target).size > 0
					: legacyExternal(argument.text, "useCreateVault") ||
							legacyExternal(argument.text, "VaultService");
			};
			for (const statement of source.statements) {
				if (ts.isClassDeclaration(statement) && statement.name) {
					const legacyMethod = statement.members.some(
						(member) =>
							ts.isMethodDeclaration(member) &&
							((ts.isIdentifier(member.name) &&
								member.name.text === "createVault") ||
								(ts.isStringLiteral(member.name) &&
									member.name.text === "createVault")),
					);
					if (statement.name.text === "VaultService" && legacyMethod) {
						changed = add(locals, statement.name.text) || changed;
						violations.add(relative(REPOSITORY_ROOT, file));
						if (
							statement.modifiers?.some(
								(m) => m.kind === ts.SyntaxKind.ExportKeyword,
							)
						) {
							const exportedName = statement.modifiers.some(
								(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
							)
								? "default"
								: statement.name.text;
							changed = add(exported, exportedName) || changed;
						}
					}
				}
				if (
					ts.isImportDeclaration(statement) &&
					ts.isStringLiteral(statement.moduleSpecifier)
				) {
					const specifier = statement.moduleSpecifier.text;
					const target = resolved(specifier, file);
					const targetExports = target ? exportsFor(target) : new Set<string>();
					const clause = statement.importClause;
					if (!clause) {
						if (targetExports.size > 0)
							violations.add(relative(REPOSITORY_ROOT, file));
						continue;
					}
					if (clause.isTypeOnly) continue;
					if (
						clause.name &&
						(targetExports.has("default") ||
							legacyBinding(specifier, "default", target))
					)
						changed = add(locals, clause.name.text) || changed;
					const bindings = clause.namedBindings;
					if (
						bindings &&
						ts.isNamespaceImport(bindings) &&
						targetExports.size > 0
					)
						changed = add(locals, bindings.name.text) || changed;
					if (bindings && ts.isNamedImports(bindings)) {
						for (const element of bindings.elements) {
							if (element.isTypeOnly) continue;
							const imported = (element.propertyName ?? element.name).text;
							if (
								targetExports.has(imported) ||
								legacyBinding(specifier, imported, target)
							)
								changed = add(locals, element.name.text) || changed;
						}
					}
				}
				if (
					ts.isExportDeclaration(statement) &&
					statement.moduleSpecifier &&
					ts.isStringLiteral(statement.moduleSpecifier) &&
					!statement.isTypeOnly
				) {
					const target = resolved(statement.moduleSpecifier.text, file);
					const targetExports = target ? exportsFor(target) : new Set<string>();
					if (!statement.exportClause) {
						for (const name of targetExports)
							changed = add(exported, name) || changed;
					} else if (ts.isNamespaceExport(statement.exportClause)) {
						if (targetExports.size > 0)
							changed =
								add(exported, statement.exportClause.name.text) || changed;
					} else if (ts.isNamedExports(statement.exportClause)) {
						for (const element of statement.exportClause.elements) {
							if (element.isTypeOnly) continue;
							const imported = (element.propertyName ?? element.name).text;
							if (
								targetExports.has(imported) ||
								legacyBinding(statement.moduleSpecifier.text, imported, target)
							)
								changed = add(exported, element.name.text) || changed;
						}
					}
				}
				if (
					ts.isExportDeclaration(statement) &&
					!statement.moduleSpecifier &&
					statement.exportClause &&
					ts.isNamedExports(statement.exportClause) &&
					!statement.isTypeOnly
				) {
					for (const element of statement.exportClause.elements) {
						if (element.isTypeOnly) continue;
						const local = (element.propertyName ?? element.name).text;
						if (locals.has(local))
							changed = add(exported, element.name.text) || changed;
					}
				}
				if (ts.isVariableStatement(statement)) {
					for (const declaration of statement.declarationList.declarations) {
						const expression = declaration.initializer;
						if (!expression) continue;
						let sourceTainted =
							ts.isIdentifier(expression) && locals.has(expression.text);
						if (importedModuleTaint(expression)) sourceTainted = true;
						if (
							ts.isNewExpression(expression) &&
							ts.isIdentifier(expression.expression)
						)
							sourceTainted = locals.has(expression.expression.text);
						if (
							ts.isPropertyAccessExpression(expression) &&
							ts.isIdentifier(expression.expression)
						)
							sourceTainted =
								locals.has(expression.expression.text) &&
								["createVault", "useCreateVault"].includes(
									expression.name.text,
								);
						if (sourceTainted && ts.isIdentifier(declaration.name))
							changed = add(locals, declaration.name.text) || changed;
						if (
							ts.isObjectBindingPattern(declaration.name) &&
							((ts.isIdentifier(expression) && locals.has(expression.text)) ||
								importedModuleTaint(expression))
						) {
							for (const element of declaration.name.elements) {
								const property = element.propertyName ?? element.name;
								if (
									(ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
									["createVault", "useCreateVault"].includes(property.text) &&
									ts.isIdentifier(element.name)
								)
									changed = add(locals, element.name.text) || changed;
							}
						}
						if (
							statement.modifiers?.some(
								(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
							) &&
							ts.isIdentifier(declaration.name) &&
							locals.has(declaration.name.text)
						)
							changed = add(exported, declaration.name.text) || changed;
					}
				}
			}
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && importedModuleTaint(node))
					violations.add(relative(REPOSITORY_ROOT, file));
				if (
					ts.isNewExpression(node) &&
					ts.isIdentifier(node.expression) &&
					locals.has(node.expression.text)
				)
					violations.add(relative(REPOSITORY_ROOT, file));
				if (
					ts.isPropertyAccessExpression(node) &&
					ts.isIdentifier(node.expression) &&
					locals.has(node.expression.text)
				)
					violations.add(relative(REPOSITORY_ROOT, file));
				if (ts.isCallExpression(node)) {
					if (
						ts.isIdentifier(node.expression) &&
						locals.has(node.expression.text)
					)
						violations.add(relative(REPOSITORY_ROOT, file));
					if (
						ts.isPropertyAccessExpression(node.expression) &&
						ts.isIdentifier(node.expression.expression) &&
						locals.has(node.expression.expression.text) &&
						["createVault", "useCreateVault"].includes(
							node.expression.name.text,
						)
					)
						violations.add(relative(REPOSITORY_ROOT, file));
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
	}
	return { files: [...violations].sort() };
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
			if (edge.symbols.length === 0) continue;
			const boundary = transitionalBoundary(edge.specifier, file);
			if (boundary !== null) {
				for (const symbol of edge.symbols)
					imports.push({
						module: boundary,
						symbol,
						file: relative(APP_ROOT, file),
					});
				continue;
			}
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
