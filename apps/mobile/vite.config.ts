import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set by `tauri android dev` when a physical device needs to reach this host.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
		}),
		react(),
		tailwindcss(),
	],
	resolve: {
		tsconfigPaths: true,
	},
	clearScreen: false,
	// Chunk B runs PBKDF2 in a worker; the WASM port ships as an ES module.
	worker: {
		format: "es",
	},
	/**
	 * `tsconfig.json` cannot set this floor — `noEmit: true` means TypeScript never emits and
	 * Vite decides. Vite 8 would otherwise default to `baseline-widely-available` (~Chrome
	 * 111), which is far above `minSdk = 24` in `gen/android/app/build.gradle.kts`.
	 *
	 * Chrome 87 is the floor chosen here. The rig's true requirement is ES module workers
	 * (`new Worker(url, { type: "module" })`, Chrome 80) plus streaming WASM instantiation
	 * (Chrome 61); 87 rounds that up and still sits under any Play-updated Android WebView,
	 * so a measurement device is never excluded by a transpile target nobody chose.
	 */
	build: {
		target: "chrome87",
	},
	server: {
		port: 3040,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 3040,
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
});
