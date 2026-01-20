import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config.js";

export default defineConfig({
	plugins: [react(), tailwindcss(), crx({ manifest })],
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
				identityAutofillIframe: "identity-autofill-iframe.html",
			},
		},
	},
});
