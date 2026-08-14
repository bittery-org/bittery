import { fileURLToPath, URL } from "node:url";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: {
		// The alias stays for `.mdx` files: they sit outside the tsconfig's
		// `include`, so tsconfig paths resolution does not cover their imports.
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
		tsconfigPaths: true,
	},
	plugins: [
		devtools(),
		nitro({}),
		tailwindcss(),
		tanstackStart(),
		mdx({
			remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
			providerImportSource: "@mdx-js/react",
		}),
		viteReact(),
	],
});

export default config;
