import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Strip Rust comments, strings (including raw SQL/test fixtures), and character literals before
// inspecting token sequences. Test assertions mentioning the removed call are not call sites.
export function callsResponseCache(source) {
	const tokens = [];
	for (let i = 0; i < source.length; ) {
		const rest = source.slice(i);
		if (rest.startsWith("//")) {
			i = source.indexOf("\n", i);
			if (i < 0) break;
			continue;
		}
		if (rest.startsWith("/*")) {
			let depth = 1;
			i += 2;
			while (depth && i < source.length) {
				if (source.startsWith("/*", i)) {
					depth++;
					i += 2;
				} else if (source.startsWith("*/", i)) {
					depth--;
					i += 2;
				} else i++;
			}
			continue;
		}
		const raw = /^(?:b)?r(#+)?"/.exec(rest);
		if (raw) {
			const end = source.indexOf(`"${raw[1] ?? ""}`, i + raw[0].length);
			i = end < 0 ? source.length : end + 1 + (raw[1]?.length ?? 0);
			continue;
		}
		if (rest[0] === '"') {
			i++;
			while (i < source.length) {
				if (source[i] === "\\") i += 2;
				else if (source[i++] === '"') break;
			}
			continue;
		}
		const char = /^'(?:[^'\\\n]|\\.)'/.exec(rest);
		if (char) {
			i += char[0].length;
			continue;
		}
		const token = /^(?:[A-Za-z_][A-Za-z_0-9]*|::|\()/.exec(rest);
		if (token) {
			tokens.push(token[0]);
			i += token[0].length;
		} else i++;
	}
	return tokens.some(
		(token, i) =>
			token === "idempotency" &&
			tokens[i + 1] === "::" &&
			tokens[i + 2] === "execute" &&
			tokens[i + 3] === "(",
	);
}
async function sources(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sources(path)));
		else if (entry.isFile() && path.endsWith(".rs")) files.push(path);
	}
	return files;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const files = await sources(
		new URL("../apps/server/src", import.meta.url).pathname,
	);
	const calls = [];
	for (const path of files)
		if (callsResponseCache(await readFile(path, "utf8"))) calls.push(path);
	if (calls.length) {
		throw new Error(`Legacy response-cache calls remain:\n${calls.join("\n")}`);
	}
	console.log(
		`Zero response-cache calls in ${files.length} Server Rust source files.`,
	);
}
