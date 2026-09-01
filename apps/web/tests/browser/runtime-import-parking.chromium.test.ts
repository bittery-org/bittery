import { afterAll, describe, expect, test } from "bun:test";
import { chromium } from "@playwright/test";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const reactEntrypoint = new URL(
	"../../node_modules/react/index.js",
	import.meta.url,
).pathname;

const hookVirtualModules: Record<string, string> = {
	"@bittery/client-runtime/react": `
		export const useRuntimeClient = () => ({
			createVault: (input) => globalThis.__runtimeImportCreateVault(input),
		});
		export const useRuntimeWritableVaults = () => ({ state: "ready", value: { vaults: [] } });
	`,
	"@bittery/core/hooks": `
		import { useSyncExternalStore } from "react";
		export const useAccountSwitcher = () => ({ activeAccount: useSyncExternalStore(
			(listener) => { globalThis.__runtimeImportAccountListeners.add(listener); return () => globalThis.__runtimeImportAccountListeners.delete(listener); },
			() => globalThis.__runtimeImportActiveAccount,
			() => null,
		) });
		export const useCoreContext = () => ({ accounts: {}, vaultRepository: {}, vaultCrypto: {} });
		export const usePlatformCrypto = () => ({});
	`,
	"@bittery/core/services/account-resolver": `export const getClientForAccount = async () => { throw new Error("unexpected legacy import"); };`,
	"@/lib/import": `
		export class ImportProviderError extends Error {}
		export const getImportProvider = (id) => id === "chrome" ? ({
			id: "chrome", title: "Chrome", canParse: () => true,
			parse: (file) => globalThis.__runtimeImportParse(file),
		}) : null;
	`,
	"@/lib/storage": "export const itemCache = {}; export const storage = {};",
	"@/providers/i18n-provider": `export const useI18n = () => ({ m: {
		vaults_import_source_vault_no_folder: () => "No folder",
		vaults_import_source_vault_chrome_passwords: () => "Chrome passwords",
		vaults_import_source_vault_no_group: () => "No group",
	} });`,
	"@/providers/transitional-sync-provider":
		"export const useQueryInvalidator = () => ({});",
};

const runtimeClientBoundaryModule = `
	export const runtimeClient = {
		async signOut(accountId) {
			globalThis.__runtimeImportLifecycleCalls.push(\`signOut:\${accountId}\`);
			return { accountId, access: "signedOut" };
		},
		async removeAccount(accountId) {
			globalThis.__runtimeImportLifecycleCalls.push(\`removeAccount:\${accountId}\`);
			return { status: "complete", failures: [] };
		},
		async deleteServerAccount({ accountId }) {
			globalThis.__runtimeImportLifecycleCalls.push(\`deleteServerAccount:\${accountId}\`);
			return { accountId, requestId: "request-1", outcome: "deleted" };
		},
		async wipe() {
			globalThis.__runtimeImportLifecycleCalls.push("wipe");
			return { status: "complete", failures: [] };
		},
	};
`;

async function buildParkingLifecycleHarness(entrypoint: string) {
	return Bun.build({
		entrypoints: [entrypoint],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "production-web-runtime-client-boundary",
				setup(build) {
					build.onResolve({ filter: /^\.\/crypto$/ }, ({ importer }) =>
						importer.endsWith("/src/lib/web-runtime-client.ts")
							? {
									path: "runtime-client",
									namespace: "runtime-client-boundary",
								}
							: undefined,
					);
					build.onLoad(
						{ filter: /.*/, namespace: "runtime-client-boundary" },
						() => ({ contents: runtimeClientBoundaryModule, loader: "js" }),
					);
				},
			},
		],
	});
}

async function buildBrowserHarness(entrypoint: string) {
	return Bun.build({
		entrypoints: [entrypoint],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "production-web-runtime-client-boundary",
				setup(build) {
					build.onResolve({ filter: /^\.\/crypto$/ }, ({ importer }) =>
						importer.endsWith("/src/lib/web-runtime-client.ts")
							? {
									path: "runtime-client",
									namespace: "runtime-client-boundary",
								}
							: undefined,
					);
					build.onLoad(
						{ filter: /.*/, namespace: "runtime-client-boundary" },
						() => ({ contents: runtimeClientBoundaryModule, loader: "js" }),
					);
				},
			},
			{
				name: "runtime-import-hook-boundaries",
				setup(build) {
					build.onResolve({ filter: /.*/ }, ({ path }) => {
						if (path === "react") return { path: reactEntrypoint };
						return path in hookVirtualModules
							? { path, namespace: "runtime-import-hook" }
							: undefined;
					});
					build.onLoad(
						{ filter: /.*/, namespace: "runtime-import-hook" },
						({ path }) => ({
							contents: hookVirtualModules[path] ?? "",
							loader: "js",
						}),
					);
				},
			},
		],
	});
}

afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("Web Runtime Import parking lifecycle in actual Chromium", () => {
	test("the production Web Runtime singleton clears only lifecycle-owned parking scopes", async () => {
		const build = await buildParkingLifecycleHarness(
			new URL("./runtime-import-parking-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output)
			throw new Error("Runtime Import lifecycle harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exerciseRuntimeImportProductionLifecycle" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseRuntimeImportProductionLifecycle(),
			);
			expect(result).toEqual({
				calls: [
					"signOut:account-a",
					"deleteServerAccount:account-b",
					"removeAccount:account-b",
					"wipe",
				],
				afterSignOut: { a: null, b: "account-b" },
				afterServerDeleteBeforeLocalRemoval: "account-b",
				afterDeleteRemoval: { a: "account-a", b: null },
				afterWipe: { a: null, b: null },
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("discards a delayed Account A provider parse after switching to Account B", async () => {
		const build = await buildBrowserHarness(
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output) throw new Error("Runtime Import hook harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		servers.push(server);

		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exerciseDelayedRuntimeImportParseSwitch" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseDelayedRuntimeImportParseSwitch(),
			);
			expect(result).toEqual({
				visiblePreview: "none",
				providerId: null,
				stage: "idle",
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("restores the accepted prefix when a later Runtime Vault target fails", async () => {
		const build = await buildBrowserHarness(
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output) throw new Error("Runtime Import hook harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exercisePartialRuntimeVaultCreationRemount" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exercisePartialRuntimeVaultCreationRemount(),
			);
			expect(result).toEqual({
				createCalls: 2,
				stage: "awaiting-runtime-import",
				error: "runtime-import-pending",
				summary: null,
				firstTargetVaultId: "accepted-vault-1",
				secondTargetVaultId: null,
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("Sign out cannot resurrect a hook-local draft after partial Runtime acceptance", async () => {
		const build = await buildBrowserHarness(
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output) throw new Error("Runtime Import hook harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exercisePartialRuntimeVaultCreationSignOut" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exercisePartialRuntimeVaultCreationSignOut(),
			);
			expect(result).toEqual({
				createCalls: 2,
				calls: ["signOut:account-a"],
				beforeSignOut: {
					stage: "awaiting-runtime-import",
					error: "runtime-import-pending",
					summary: null,
					firstTargetVaultId: "accepted-vault-1",
					secondTargetVaultId: null,
				},
				afterSignOut: {
					preview: null,
					mappings: {},
					stage: "idle",
					error: null,
					accountADraft: null,
					accountBDraft: "account-b",
				},
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("production retirement fences an acceptance that arrives after lifecycle cleanup", async () => {
		const build = await buildBrowserHarness(
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output) throw new Error("Runtime Import hook harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exerciseRuntimeImportAcceptanceRetirementRaces" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseRuntimeImportAcceptanceRetirementRaces(),
			);
			expect(result).toEqual({
				lifecycleCalls: [
					"signOut:account-a",
					"removeAccount:account-a",
					"wipe",
				],
				results: [
					{
						action: "signOut",
						outcome: null,
						stage: "idle",
						summary: null,
						error: null,
						accountADraft: null,
						accountBDraft: "account-b",
						acceptedVaultId: "accepted-vault-signOut",
					},
					{
						action: "removeAccount",
						outcome: null,
						stage: "idle",
						summary: null,
						error: null,
						accountADraft: null,
						accountBDraft: "account-b",
						acceptedVaultId: "accepted-vault-removeAccount",
					},
					{
						action: "wipe",
						outcome: null,
						stage: "idle",
						summary: null,
						error: null,
						accountADraft: null,
						accountBDraft: null,
						acceptedVaultId: "accepted-vault-wipe",
					},
				],
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("parks a delayed Account A acceptance without completing or writing Account B", async () => {
		const build = await buildBrowserHarness(
			new URL("./runtime-import-hook-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output) throw new Error("Runtime Import hook harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		servers.push(server);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exerciseDelayedRuntimeVaultAcceptanceSwitch" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseDelayedRuntimeVaultAcceptanceSwitch(),
			);
			expect(result).toEqual({
				outcome: null,
				visiblePreview: "none",
				accountATarget: "accepted-vault-a",
				accountBDraft: null,
			});
		} finally {
			await browser.close();
		}
	}, 30_000);

	test("restores a parked draft after remount and isolates active Accounts", async () => {
		const build = await buildParkingLifecycleHarness(
			new URL("./runtime-import-parking-chromium-harness.tsx", import.meta.url)
				.pathname,
		);
		expect(build.success).toBe(true);
		const output = build.outputs[0];
		if (!output)
			throw new Error("Runtime Import parking harness did not build");
		const harness = await output.text();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/harness.js") {
					return new Response(harness, {
						headers: { "content-type": "text/javascript" },
					});
				}
				return new Response(
					'<main id="root"></main><script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		servers.push(server);

		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => "exerciseRuntimeImportParkingLifecycle" in globalThis,
			);
			const result = await page.evaluate(() =>
				globalThis.exerciseRuntimeImportParkingLifecycle(),
			);
			expect(result).toEqual({
				firstMount: "Account A draft",
				remount: "Account A draft",
				switchedToB: "Account B draft",
				accountAAfterBPark: "Account A draft",
				clearedB: "none",
				switchedBackToA: "Account A draft",
			});
			const retiredLeases = await page.evaluate(() =>
				globalThis.exerciseRuntimeImportRetiredLeaseFencing(),
			);
			expect(retiredLeases).toEqual({
				scopedAttempt: { state: "retired" },
				globalAttempts: [{ state: "retired" }, { state: "retired" }],
				afterScoped: null,
				afterGlobal: null,
			});
		} finally {
			await browser.close();
		}
	}, 30_000);
});
