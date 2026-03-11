import { createHash } from "node:crypto";

const INLINE_SCRIPT_PATTERN =
	/<script\b(?![^>]*\bsrc=)(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/gi;

export function collectInlineScriptHashes(htmlDocuments) {
	const hashes = new Set();

	for (const html of htmlDocuments) {
		let match;
		// biome-ignore lint/suspicious/noAssignInExpressions: This is a common pattern for regex matching in JavaScript.
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

export function resolveConnectSrc(serverUrl) {
	const sources = new Set(["'self'"]);

	if (!serverUrl) {
		return [...sources].join(" ");
	}

	let parsed;
	try {
		parsed = new URL(serverUrl);
	} catch {
		return [...sources].join(" ");
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return [...sources].join(" ");
	}

	sources.add(parsed.origin);
	return [...sources].join(" ");
}

export function renderNginxConfig(template, scriptHashes, connectSrc) {
	return template
		.replace("__CSP_SCRIPT_HASHES__", scriptHashes.join(" "))
		.replace("__CSP_CONNECT_SRC__", connectSrc);
}
