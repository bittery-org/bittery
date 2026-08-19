import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeServerUrl } from "../../../packages/shared/src/server-url.ts";
import {
	collectInlineScriptHashes,
	renderNginxConfig,
	resolveConnectSrc,
} from "./csp.js";

async function findHtmlFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findHtmlFiles(fullPath)));
			continue;
		}

		if (entry.isFile() && fullPath.endsWith(".html")) {
			files.push(fullPath);
		}
	}

	return files;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../../..");
const templatePath = resolve(repoRoot, "apps/web/nginx.conf");
const distDirectory = resolve(repoRoot, "apps/web/dist/client");
const outputPath = resolve(repoRoot, "apps/web/.generated/nginx.conf");

const htmlFiles = await findHtmlFiles(distDirectory);
if (htmlFiles.length === 0) {
	throw new Error("No HTML files found in apps/web/dist/client");
}

const htmlDocuments = await Promise.all(
	htmlFiles.map((filePath) => readFile(filePath, "utf8")),
);
const template = await readFile(templatePath, "utf8");
const scriptHashes = collectInlineScriptHashes(htmlDocuments);
const normalizedServerUrl = normalizeServerUrl(
	process.env.VITE_SERVER_URL ?? "",
);
const connectSrc = resolveConnectSrc(normalizedServerUrl);
const renderedConfig = renderNginxConfig(template, scriptHashes, connectSrc);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderedConfig);
