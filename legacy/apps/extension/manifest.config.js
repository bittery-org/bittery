import { readFileSync } from "node:fs";
import { defineManifest } from "@crxjs/vite-plugin";

// Derived rather than tracked in scripts/sync-version.mjs so the version users
// see in the browser cannot drift from the rest of the release.
const { version } = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineManifest({
	manifest_version: 3,
	default_locale: "en",
	name: "__MSG_extName__",
	version,
	description: "__MSG_extDescription__",
	permissions: [
		"storage",
		"unlimitedStorage",
		"activeTab",
		"scripting",
		"clipboardWrite",
		"alarms",
		"nativeMessaging",
	],
	host_permissions: ["<all_urls>"],
	action: {
		default_popup: "popup.html",
		default_icon: {
			16: "icons/icon-16.png",
			32: "icons/icon-32.png",
			48: "icons/icon-48.png",
			128: "icons/icon-128.png",
		},
	},
	background: {
		service_worker: "src/background/index.ts",
		type: "module",
	},
	content_scripts: [
		{
			matches: ["<all_urls>"],
			js: ["src/page-script/passkey.ts"],
			run_at: "document_start",
			all_frames: true,
			world: "MAIN",
		},
		{
			matches: ["<all_urls>"],
			js: ["src/content-script/passkey-bridge-entry.ts"],
			run_at: "document_start",
			all_frames: true,
		},
		{
			matches: ["<all_urls>"],
			js: ["src/content.ts"],
			run_at: "document_end",
			all_frames: false,
		},
	],
	icons: {
		16: "icons/icon-16.png",
		32: "icons/icon-32.png",
		48: "icons/icon-48.png",
		128: "icons/icon-128.png",
	},
	content_security_policy: {
		extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
	},
	web_accessible_resources: [
		{
			resources: [
				"autofill-iframe.html",
				"save-prompt-iframe.html",
				"credit-card-autofill-iframe.html",
				"identity-autofill-iframe.html",
				"passkey-picker-iframe.html",
				"passkey-save-target-iframe.html",
				"icons/lock-icon.png",
			],
			matches: ["<all_urls>"],
		},
	],
});
