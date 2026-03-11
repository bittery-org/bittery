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
	// Let CRX derive extension pages from the manifest. Manual HTML inputs
	// cause dev inline scripts to be registered twice for iframe pages.
});
