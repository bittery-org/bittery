import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The MV3 worker has no document. Check the actual release module graph because
// Vite can insert a DOM-based preload helper into a shared chunk at build time.
const dist = resolve(process.argv[2] ?? join(import.meta.dirname, "../dist"));
const visited = new Set();
let domPreloadHelper = null;

function visit(file) {
	const resolved = resolve(file);
	const withinDist = relative(dist, resolved);
	if (withinDist.startsWith("..") || withinDist.startsWith("/")) {
		throw new Error(
			`Service worker import escaped the release package: ${withinDist}`,
		);
	}
	if (visited.has(resolved)) return;
	visited.add(resolved);
	const source = readFileSync(resolved, "utf8");
	if (
		/modulepreload/.test(source) &&
		(/document\.getElementsByTagName\(\s*[`'"]link[`'"]\s*\)/.test(source) ||
			/window\.dispatchEvent\(/.test(source))
	) {
		domPreloadHelper = withinDist;
	}
	for (const match of source.matchAll(
		/\b(?:from|import)\s*["'](\.[^"']+)["']/g,
	)) {
		visit(resolve(dirname(resolved), match[1]));
	}
}

visit(join(dist, "service-worker-loader.js"));
if (visited.size < 2) {
	throw new Error(
		"Service worker release graph did not include its bundled entrypoint",
	);
}
if (domPreloadHelper) {
	throw new Error(
		`Service worker release graph contains a DOM-based module preload: ${domPreloadHelper}`,
	);
}
console.log(`Service worker release graph checked: ${visited.size} modules`);
