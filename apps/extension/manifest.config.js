import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
	manifest_version: 3,
	name: "Bittery",
	version: "0.1.0",
	description: "Passwords and passkeys, encrypted on your device. Zero-knowledge autofill.",
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
