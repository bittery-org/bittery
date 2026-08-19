import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const ignoredSource =
	/(?:^|\/)(?:__tests__|generated|node_modules|dist|build|target)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ignoredDirectory = new Set([
	"node_modules",
	"dist",
	"build",
	"target",
	"generated",
	"__tests__",
]);

const forbiddenDependencies = new Map([
	["ui", new Set(["core", "storage", "sync"])],
	["core", new Set(["ui"])],
	["sync", new Set(["core", "storage", "ui"])],
	["shared", new Set(["core", "storage", "sync", "ui"])],
]);

function tokens(source, start = 0, stopAtClosingBrace = false) {
	const result = [];
	let index = start;
	let braceDepth = 0;
	while (index < source.length) {
		const character = source[index];
		if (stopAtClosingBrace && character === "}") {
			if (braceDepth === 0) return { result, index: index + 1 };
			braceDepth--;
			result.push({ type: "punctuation", value: character });
			index++;
			continue;
		}
		if (stopAtClosingBrace && character === "{") {
			braceDepth++;
			result.push({ type: "punctuation", value: character });
			index++;
			continue;
		}
		if (/\s/.test(character)) {
			index++;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			index = source.indexOf("\n", index + 2);
			if (index < 0) break;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const quote = character;
			let value = "";
			let constant = true;
			index++;
			while (index < source.length) {
				if (source[index] === "\\") {
					value += source.slice(index, index + 2);
					index += 2;
					continue;
				}
				if (
					quote === "`" &&
					source[index] === "$" &&
					source[index + 1] === "{"
				) {
					constant = false;
					const expression = tokens(source, index + 2, true);
					result.push(...expression.result);
					index = expression.index;
					continue;
				}
				if (source[index] === quote) {
					index++;
					break;
				}
				value += source[index++];
			}
			result.push({ type: "string", value, constant });
			continue;
		}
		if (/[A-Za-z_$]/.test(character)) {
			const start = index++;
			while (index < source.length && /[\w$]/.test(source[index])) index++;
			result.push({ type: "word", value: source.slice(start, index) });
			continue;
		}
		result.push({ type: "punctuation", value: character });
		index++;
	}
	return { result, index };
}

function constantString(token) {
	return token?.type === "string" && token.constant ? token.value : null;
}

export function extractImportSpecifiers(source) {
	const parsed = tokens(source).result;
	const specifiers = [];
	for (let index = 0; index < parsed.length; index++) {
		const token = parsed[index];
		if (token.type !== "word") continue;
		if (token.value === "require" && parsed[index - 1]?.value !== ".") {
			const value =
				parsed[index + 1]?.value === "(" && parsed[index + 3]?.value === ")"
					? constantString(parsed[index + 2])
					: null;
			if (value !== null) specifiers.push(value);
			continue;
		}
		if (token.value !== "import" && token.value !== "export") continue;
		if (token.value === "import" && parsed[index + 1]?.value === "(") {
			const value =
				parsed[index + 3]?.value === ")" || parsed[index + 3]?.value === ","
					? constantString(parsed[index + 2])
					: null;
			if (value !== null) specifiers.push(value);
			continue;
		}
		const sideEffect = constantString(parsed[index + 1]);
		if (sideEffect !== null) {
			specifiers.push(sideEffect);
			continue;
		}
		for (let cursor = index + 1; cursor < parsed.length; cursor++) {
			if (parsed[cursor].value === ";") break;
			if (parsed[cursor].value === "from") {
				const value = constantString(parsed[cursor + 1]);
				if (value !== null) specifiers.push(value);
				break;
			}
		}
	}
	return specifiers;
}

function packageName(name) {
	return name.startsWith("@bittery/") ? name.slice("@bittery/".length) : name;
}

function owningPackage(file, packageOwners) {
	return packageOwners
		.filter(
			({ root }) => file === root || file.startsWith(`${root}${path.sep}`),
		)
		.sort((left, right) => right.root.length - left.root.length)[0];
}

export function classifyImport(
	importer,
	specifier,
	repositoryRoot,
	packageOwners = [],
) {
	const workspaceMatch = specifier.match(/^@bittery\/([^/]+)/);
	if (workspaceMatch) return workspaceMatch[1];
	if (!specifier.startsWith(".")) return null;

	const target = path.resolve(path.dirname(importer), specifier);
	const relativeTarget = path.relative(repositoryRoot, target);
	if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))
		return null;
	if (relativeTarget.split(path.sep)[0] === "apps") return "apps";
	return owningPackage(target, packageOwners)?.name ?? null;
}

export function findViolation(importerPackage, dependency) {
	if (dependency === "apps") return "packages cannot import apps";
	if (importerPackage === "types" && dependency !== "api-contract") {
		return "@bittery/types may only import @bittery/api-contract";
	}
	if (forbiddenDependencies.get(importerPackage)?.has(dependency)) {
		return `@bittery/${importerPackage} cannot import @bittery/${dependency}`;
	}
	return null;
}

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.isDirectory() && ignoredDirectory.has(entry.name)) continue;
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
		else if (sourceExtension.test(entry.name) && !ignoredSource.test(file))
			files.push(file);
	}
	return files;
}

async function packageSourceFiles(owner) {
	const files = [];
	try {
		files.push(...(await sourceFiles(path.join(owner.root, "src"))));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	for (const entry of await readdir(owner.root, { withFileTypes: true })) {
		const file = path.join(owner.root, entry.name);
		if (
			entry.isFile() &&
			sourceExtension.test(entry.name) &&
			!ignoredSource.test(file)
		) {
			files.push(file);
		}
	}
	return files;
}

export async function discoverPackages(packagesRoot) {
	const found = [];
	async function visit(directory) {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && ignoredDirectory.has(entry.name)) continue;
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(file);
			} else if (entry.name === "package.json") {
				const manifest = JSON.parse(await readFile(file, "utf8"));
				if (manifest.name) {
					found.push({ name: packageName(manifest.name), root: directory });
				}
			}
		}
	}
	await visit(packagesRoot);
	return found;
}

export async function checkArchitecture(repositoryRoot) {
	const packageOwners = await discoverPackages(
		path.join(repositoryRoot, "packages"),
	);
	const violations = [];
	for (const owner of packageOwners) {
		const files = await packageSourceFiles(owner);
		for (const file of files) {
			if (owningPackage(file, packageOwners)?.root !== owner.root) continue;
			const source = await readFile(file, "utf8");
			for (const specifier of extractImportSpecifiers(source)) {
				const dependency = classifyImport(
					file,
					specifier,
					repositoryRoot,
					packageOwners,
				);
				if (!dependency || dependency === owner.name) continue;
				const reason = findViolation(owner.name, dependency);
				if (reason) {
					violations.push(
						`${path.relative(repositoryRoot, file)} imports ${specifier}: ${reason}`,
					);
				}
			}
		}
	}
	return violations;
}

async function main() {
	const repositoryRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const violations = await checkArchitecture(repositoryRoot);
	if (violations.length > 0) {
		console.error(
			`Architecture dependency violations:\n${violations.join("\n")}`,
		);
		process.exitCode = 1;
	} else {
		console.log("Architecture dependency directions are valid.");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
