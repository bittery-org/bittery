import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";

const modules: Record<string, string> = {
	"@bittery/client-runtime/react": `
		import { useSyncExternalStore } from "react";
		export const useRuntimeClient = () => globalThis.__importClient;
		export const useRuntimeSession = () => ({state: "unlocked", accountId: useSyncExternalStore(
			listener => { globalThis.__importAccountListeners.add(listener); return () => globalThis.__importAccountListeners.delete(listener); },
			() => globalThis.__importAccount, () => null)});
		export const useRuntimeWritableVaults = () => ({ state: "ready", value: {vaults: globalThis.__importVaults} });
		export const useRuntimeOperations = () => ({ state: "ready", value: {operations: []} });
	`,
	"@bittery/core/hooks": `
		import { useSyncExternalStore } from "react";
		export const useAccountSwitcher = () => ({ activeAccount: useSyncExternalStore(
			listener => { globalThis.__importAccountListeners.add(listener); return () => globalThis.__importAccountListeners.delete(listener); },
			() => globalThis.__importAccount + "-legacy", () => null) });
	`,
	"@/lib/import": `
		export class ImportProviderError extends Error {}
		export const getImportProvider = () => ({ id: "chrome", title: "Chrome", canParse: () => true,
			parse: () => globalThis.__importParse(), toDecryptedItemData: item => item });
	`,
	"@/providers/i18n-provider": "export const useI18n = () => ({ m: {} });",
};

test("Import hook uses durable projection outcomes for categories, mappings, batches, size refusals and caller detachment", async () => {
	const build = await Bun.build({
		entrypoints: [
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "import-boundaries",
				setup(build) {
					build.onResolve({ filter: /.*/ }, ({ path }) =>
						path === "react"
							? {
									path: new URL(
										"../../node_modules/react/index.js",
										import.meta.url,
									).pathname,
								}
							: path in modules
								? { path, namespace: "import-boundaries" }
								: undefined,
					);
					build.onLoad(
						{ filter: /.*/, namespace: "import-boundaries" },
						({ path }) => ({ contents: modules[path] ?? "", loader: "js" }),
					);
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const output = build.outputs[0];
	if (!output) throw new Error("Import harness missing");
	const harness = await output.text();
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/harness.js"
				? new Response(harness, {
						headers: { "content-type": "text/javascript" },
					})
				: new Response('<script type="module" src="/harness.js"></script>', {
						headers: { "content-type": "text/html" },
					}),
	});
	const browser = await chromium.launch({ headless: true });
	try {
		for (const scenario of [
			"new",
			"existing",
			"size",
			"later-rejection",
			"detach",
			"switch",
			"sparse-note",
			"sparse-totp",
		]) {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(() => "exerciseImport" in globalThis);
			const result = (await page.evaluate(
				(scenario) => globalThis.exerciseImport(scenario),
				scenario,
			)) as {
				summary: null | {
					importedCount: number;
					skippedCount: number;
					createdVaultCount: number;
					failedVaultCount: number;
				};
				calls: Array<{
					accountId: string;
					items: number;
					categories: string[];
					favorites: boolean[];
					drafts: Array<{ category: string; data: { title: string } }>;
				}>;
				filteredEmptyVaults: number;
				beforeApplied: unknown;
				subscriptions: number;
				applied: number;
			};
			if (scenario.startsWith("sparse-")) {
				expect(result.calls).toHaveLength(1);
				expect(result.calls[0]?.drafts).toEqual([
					{
						category:
							scenario === "sparse-note" ? "secure-note" : "authenticator",
						data: { title: "Item 0" },
					},
				]);
				expect(result.summary?.importedCount).toBe(0);
				expect(result.summary?.skippedCount).toBe(1);
				expect(result.summary?.failedVaultCount).toBe(1);
				expect(result.applied).toBe(0);
				expect(result.subscriptions).toBe(0);
				await page.close();
				continue;
			}
			expect(result.filteredEmptyVaults).toBe(1);
			expect(result.beforeApplied).toBeNull();
			expect(result.subscriptions).toBe(0);
			if (scenario === "detach" || scenario === "switch") {
				expect(result.summary).toBeNull();
				expect(result.applied).toBe(1);
			} else {
				expect(result.summary?.importedCount).toBe(
					scenario === "size" ? 4 : scenario === "later-rejection" ? 200 : 5,
				);
				expect(result.summary?.skippedCount).toBe(
					["size", "later-rejection"].includes(scenario) ? 1 : 0,
				);
				expect(result.summary?.failedVaultCount).toBe(
					["size", "later-rejection"].includes(scenario) ? 1 : 0,
				);
				expect(result.summary?.createdVaultCount).toBe(
					scenario === "existing" ? 0 : 1,
				);
			}
			expect(result.calls[0]?.accountId).toBe(
				scenario === "existing" ? "account-b" : "account-a",
			);
			if (scenario === "later-rejection")
				expect(result.calls.map((call) => call.items)).toEqual([200, 1]);
			else
				expect(result.calls[0]?.categories).toEqual([
					"login",
					"secure-note",
					"credit-card",
					"identity",
					"authenticator",
				]);
			expect(result.calls[0]?.favorites[0]).toBe(true);
			await page.close();
		}
	} finally {
		await browser.close();
		server.stop(true);
	}
}, 30_000);
