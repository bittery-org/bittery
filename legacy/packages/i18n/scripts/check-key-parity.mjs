import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const messagesDir = path.join(rootDir, "messages");
const englishFile = path.join(messagesDir, "en.json");
const germanFile = path.join(messagesDir, "de.json");

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function flattenKeys(value, prefix = "") {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return prefix ? [prefix] : [];
	}

	const keys = [];
	for (const [key, nested] of Object.entries(value)) {
		const nextPrefix = prefix ? `${prefix}.${key}` : key;
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			keys.push(...flattenKeys(nested, nextPrefix));
			continue;
		}
		keys.push(nextPrefix);
	}
	return keys;
}

function diff(left, right) {
	const rightSet = new Set(right);
	return left.filter((key) => !rightSet.has(key)).sort();
}

const englishMessages = readJson(englishFile);
const germanMessages = readJson(germanFile);

const englishKeys = flattenKeys(englishMessages);
const germanKeys = flattenKeys(germanMessages);

const missingInGerman = diff(englishKeys, germanKeys);
const extraInGerman = diff(germanKeys, englishKeys);

if (missingInGerman.length === 0 && extraInGerman.length === 0) {
	console.log("i18n key parity check passed: en.json and de.json are in sync.");
	process.exit(0);
}

console.error("i18n key parity check failed.");

if (missingInGerman.length > 0) {
	console.error("\nMissing in de.json:");
	for (const key of missingInGerman) {
		console.error(`  - ${key}`);
	}
}

if (extraInGerman.length > 0) {
	console.error("\nExtra in de.json:");
	for (const key of extraInGerman) {
		console.error(`  - ${key}`);
	}
}

process.exit(1);
