import { createHash } from "node:crypto";

const INLINE_SCRIPT_PATTERN =
	/<script\b(?![^>]*\bsrc=)(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/gi;

export function collectInlineScriptHashes(htmlDocuments) {
	const hashes = new Set();

	for (const html of htmlDocuments) {
		let match;
		while ((match = INLINE_SCRIPT_PATTERN.exec(html)) !== null) {
			const scriptContent = match[1] ?? "";
			if (!scriptContent.trim()) {
				continue;
			}

			const hash = createHash("sha256")
				.update(scriptContent, "utf8")
				.digest("base64");
			hashes.add(`'sha256-${hash}'`);
		}

		INLINE_SCRIPT_PATTERN.lastIndex = 0;
	}

	return [...hashes].sort();
}

export function renderNginxConfig(template, scriptHashes) {
	return template.replace("__CSP_SCRIPT_HASHES__", scriptHashes.join(" "));
}
