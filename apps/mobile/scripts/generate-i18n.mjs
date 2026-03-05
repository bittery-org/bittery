import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@inlang/paraglide-js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");

const project = path.resolve(appDir, "../../packages/i18n/project.inlang");
const outdir = path.resolve(appDir, "src/paraglide");

await compile({
	project,
	outdir,
	strategy: ["baseLocale"],
	emitGitIgnore: true,
});
