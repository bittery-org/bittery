import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");
const messagesDir = path.resolve(extensionDir, "../../packages/i18n/messages");
const localesDir = path.resolve(extensionDir, "public/_locales");

const MANIFEST_MESSAGE_KEYS = {
	extName: "MSG_extName",
	extDescription: "MSG_extDescription",
};

const locales = ["en", "de"];

for (const locale of locales) {
	const messagesPath = path.join(messagesDir, `${locale}.json`);
	const messages = JSON.parse(await fs.readFile(messagesPath, "utf8"));

	const chromeMessages = {};
	for (const [chromeKey, i18nKey] of Object.entries(MANIFEST_MESSAGE_KEYS)) {
		const message = messages[i18nKey];
		if (typeof message !== "string") {
			throw new Error(`Missing i18n key "${i18nKey}" in ${messagesPath}`);
		}
		chromeMessages[chromeKey] = { message };
	}

	const outDir = path.join(localesDir, locale);
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(
		path.join(outDir, "messages.json"),
		`${JSON.stringify(chromeMessages, null, "\t")}\n`,
	);
}
