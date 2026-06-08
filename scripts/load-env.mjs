import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(".env");

if (!existsSync(envFile)) {
	process.exit(0);
}

for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		continue;
	}

	const separator = trimmed.indexOf("=");
	if (separator === -1) {
		continue;
	}

	const key = trimmed.slice(0, separator).trim();
	if (!key) {
		continue;
	}

	let value = trimmed.slice(separator + 1).trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}

	process.env[key] = value;
}
