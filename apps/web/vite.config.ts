import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Deliberately unprefixed: this configures the dev server itself, not client
// code, so it must not reach `import.meta.env`. Set by playwright.config.ts.
const isE2E = process.env.E2E === "1";

export default defineConfig({
	plugins: [
		tailwindcss(),
		tanstackStart({
			spa: {
				enabled: true,
				prerender: {
					outputPath: "/index.html",
					crawlLinks: true,
					retryCount: 3,
				},
			},
		}),
		viteReact(),
	],
	resolve: {
		// `worker` inherits this, so the worker bundle resolves `@/*` too.
		tsconfigPaths: true,
	},
	worker: {
		format: "es",
	},
	server: {
		host: true,
		port: 3001,
		allowedHosts: ["bittery.test"],
		// One dev server serves every Playwright worker, and a dependency
		// re-optimization broadcasts `full-reload` to all of them at once - so one
		// worker's navigation reloads the others' pages mid-flow.
		...(isE2E && { hmr: false }),
	},
	// Discovered lazily (recovery-kit imports pdf-lib on demand, and the router
	// code-splits every route), which is what triggers that mid-run re-optimize.
	...(isE2E && {
		optimizeDeps: {
			noDiscovery: true,
			include: [
				"react",
				"react-dom",
				"react/jsx-dev-runtime",
				"react/jsx-runtime",
				"react-dom/client",
				"@tanstack/react-router > @tanstack/react-store",
				"@dnd-kit/core",
				"@tanstack/react-form",
				"@tanstack/react-query",
				"@tanstack/react-query-devtools",
				"date-fns",
				"date-fns/locale",
				"jszip",
				"lucide-react",
				"nanoid",
				"next-themes",
				"pdf-lib",
				"qrcode.react",
				"use-sync-external-store/shim",
				"use-sync-external-store/shim/with-selector",
				"zxcvbn",
			],
		},
	}),
});
