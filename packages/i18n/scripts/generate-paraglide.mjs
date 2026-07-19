import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@inlang/paraglide-js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

const project = path.resolve(packageDir, "project.inlang");
const outdir = path.resolve(packageDir, "src/paraglide");

await compile({
	project,
	outdir,
	emitTsDeclarations: true,
	strategy: ["baseLocale"],
	emitGitIgnore: true,
});

// patch the generated .gitignore to not ignore the gitnore itself
const gitignorePath = path.join(outdir, ".gitignore");
const gitignoreContent = await fs.readFile(gitignorePath, "utf8");
const patchedGitignoreContent = gitignoreContent.replace("*", "*\n!.gitignore");
await fs.writeFile(gitignorePath, patchedGitignoreContent, "utf8");

// Vite doesn't content-hash workspace deps, so any app that pre-bundles
// @bittery/i18n via optimizeDeps would keep serving a stale messages module
// after regeneration. Drop those caches so the next dev-server start rebuilds.
const repoRoot = path.resolve(packageDir, "../..");
const appsDir = path.join(repoRoot, "apps");
for (const entry of await fs.readdir(appsDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const depsDir = path.join(appsDir, entry.name, "node_modules/.vite/deps");
	const files = await fs.readdir(depsDir).catch(() => []);
	if (files.some((file) => file.includes("_i18n_"))) {
		await fs.rm(path.dirname(depsDir), { recursive: true, force: true });
		console.log(`Cleared stale Vite dep cache in apps/${entry.name}`);
	}
}
