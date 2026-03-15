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
