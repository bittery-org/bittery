import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config.js";

export default defineConfig({
	plugins: [
		react({
			// Exclude service worker from React Refresh (no window/DOM APIs available)
			exclude: [/src\/background\//],
		}),
		tailwindcss(),
		crx({ manifest }),
	],
	resolve: {
		alias: {
			"@": "/src",
		},
	},
	server: {
		cors: {
			origin: [/chrome-extension:\/\//],
		},
	},
	build: {
		rollupOptions: {
			input: {
				popup: "popup.html",
				autofillIframe: "autofill-iframe.html",
				savePromptIframe: "save-prompt-iframe.html",
				creditCardAutofillIframe: "credit-card-autofill-iframe.html",
				identityAutofillIframe: "identity-autofill-iframe.html",
			},
		},
	},
});
