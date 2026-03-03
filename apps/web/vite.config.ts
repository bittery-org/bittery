import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [
		paraglideVitePlugin({
			project: "../../packages/i18n/project.inlang",
			outdir: "./src/paraglide",
			strategy: ["localStorage", "preferredLanguage", "baseLocale"],
			localStorageKey: "bittery.locale",
		}),
		tsconfigPaths(),
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
	worker: {
		format: "es",
		plugins: () => [tsconfigPaths()],
	},
	server: {
		host: true,
		port: 3001,
		allowedHosts: ["bittery.test"],
	},
});
