import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
});

type Mode =
	| "success"
	| "lossBefore"
	| "lossAfter"
	| "uploadFailures"
	| "rejection"
	| "teardown";

type RejectionCode =
	| "vault_id_conflict"
	| "team_membership_required"
	| "vault_sharing_entitlement_denied"
	| "shared_vault_limit_reached";

type ServerState = {
	mode: Mode;
	routes: string[];
	sync: { opened: number; cancelled: number; changes: number };
	completed: boolean;
	rejected: boolean;
	cleanupCount: number;
	uploadAttempts: number;
	putAttempts: number;
	putEffects: number;
	networkFailures: number;
	rejectionCode?: RejectionCode;
	vault?: Record<string, unknown>;
	encryptedVaultKey?: string;
	outcome?: Record<string, unknown>;
	uploaded: boolean;
	importedItems?: Array<Record<string, unknown>>;
	importOutcome?: Record<string, unknown>;
	importDecisions?: Record<
		string,
		{ body: string; outcome: Record<string, unknown> }
	>;
	importRejectAfter?: number;
	importRequestIds?: string[];
	importUsers?: string[];
	importAttempts?: number;
	importEffects?: number;
	importBodies?: string[];
};

function freshState(mode: Mode): ServerState {
	return {
		mode,
		routes: [],
		sync: { opened: 0, cancelled: 0, changes: 0 },
		completed: false,
		rejected: false,
		cleanupCount: 0,
		uploadAttempts: 0,
		putAttempts: 0,
		putEffects: 0,
		networkFailures: 0,
		uploaded: false,
	};
}

// These histories seed authority directly and exercise foreground Operations. Background
// Sync stays connected with no remote changes; it is tracked separately from ceremony effects.
function joinedSyncResponse(
	request: Request,
	state: ServerState,
): Response | undefined {
	if (request.method !== "GET") return undefined;
	const path = new URL(request.url).pathname;
	const headers = { "access-control-allow-origin": "*" };
	if (path === "/api/v1/sync/changes") {
		state.sync.changes += 1;
		return Response.json(
			{ events: [], cursor: null, hasMore: false, requiresFullRefresh: false },
			{ headers },
		);
	}
	if (path !== "/api/v1/sync/events") return undefined;
	state.sync.opened += 1;
	let retire = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let active = true;
			const abort = () => {
				retire();
				controller.close();
			};
			retire = () => {
				if (!active) return;
				active = false;
				state.sync.cancelled += 1;
				request.signal.removeEventListener("abort", abort);
			};
			controller.enqueue(
				new TextEncoder().encode("event: connected\ndata: {}\n\n"),
			);
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort();
		},
		cancel() {
			retire();
		},
	});
	return new Response(body, {
		headers: { ...headers, "content-type": "text/event-stream" },
	});
}

test("joined Sync fixture holds its stream until cancellation and serves only explicit routes", async () => {
	for (const cancellation of ["reader", "request"] as const) {
		const state = freshState("success");
		const abort = new AbortController();
		const response = joinedSyncResponse(
			new Request("http://joined.test/api/v1/sync/events", {
				signal: abort.signal,
			}),
			state,
		);
		expect(response?.headers.get("content-type")).toBe("text/event-stream");
		const reader = response?.body?.getReader();
		if (!reader) throw new Error("fixture must supply a streaming body");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"event: connected\ndata: {}\n\n",
		);
		let settled = false;
		const pending = reader.read().then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		if (cancellation === "reader") await reader.cancel();
		else abort.abort();
		expect((await pending).done).toBe(true);
		await reader.cancel();
		abort.abort();
		expect(state.sync).toEqual({ opened: 1, cancelled: 1, changes: 0 });
		const changes = joinedSyncResponse(
			new Request("http://joined.test/api/v1/sync/changes?sinceId=seed"),
			state,
		);
		expect(await changes?.json()).toEqual({
			events: [],
			cursor: null,
			hasMore: false,
			requiresFullRefresh: false,
		});
		expect(state.sync.changes).toBe(1);
		for (const [path, method] of [
			["events", "POST"],
			["changes", "POST"],
			["unexpected", "GET"],
		]) {
			expect(
				joinedSyncResponse(
					new Request(`http://joined.test/api/v1/sync/${path}`, { method }),
					state,
				),
			).toBeUndefined();
		}
		expect(state.routes).toEqual([]);
	}
});

describe("create-Vault joined production path in actual Chromium", () => {
	test("covers Vault lifecycle and real-Core Import mapping, replay, and independent batch outcomes", async () => {
		const [harnessBuild, workerBuild, importHarnessBuild] = await Promise.all([
			Bun.build({
				entrypoints: [
					new URL("./web-create-vault-chromium-harness.ts", import.meta.url)
						.pathname,
				],
				target: "browser",
				format: "esm",
			}),
			Bun.build({
				entrypoints: [
					new URL("./web-create-vault-worker.ts", import.meta.url).pathname,
				],
				target: "browser",
				format: "esm",
			}),
			Bun.build({
				entrypoints: [
					new URL(
						"./web-create-vault-import-chromium-harness.tsx",
						import.meta.url,
					).pathname,
				],
				target: "browser",
				format: "esm",
				plugins: [
					{
						name: "joined-import-host-boundaries",
						setup(build) {
							build.onResolve({ filter: /^\.\/crypto$/ }, ({ importer }) =>
								importer.endsWith("/src/lib/web-runtime-client.ts")
									? {
											path: "joined-runtime-client",
											namespace: "joined-import",
										}
									: undefined,
							);
							build.onResolve({ filter: /^@bittery\/core\/hooks$/ }, () => ({
								path: "core-hooks",
								namespace: "joined-import",
							}));
							build.onResolve(
								{ filter: /^@bittery\/core\/services\/account-resolver$/ },
								() => ({ path: "legacy-resolver", namespace: "joined-import" }),
							);
							for (const [filter, path] of [
								[/^@\/lib\/import$/, "import-provider"],
								[/^@\/lib\/storage$/, "storage"],
								[/^@\/providers\/i18n-provider$/, "i18n"],
								[/^@\/providers\/transitional-sync-provider$/, "invalidator"],
							] as const) {
								build.onResolve({ filter }, () => ({
									path,
									namespace: "joined-import",
								}));
							}
							build.onLoad(
								{ filter: /.*/, namespace: "joined-import" },
								({ path }) => ({
									loader: "js",
									contents: joinedImportModule(path),
								}),
							);
						},
					},
				],
			}),
		]);
		expect(harnessBuild.success).toBe(true);
		expect(workerBuild.success).toBe(true);
		expect(importHarnessBuild.success).toBe(true);
		const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
		if (bindingsRoot === undefined)
			throw new Error("joined create-Vault generated bindings are unavailable");
		const harnessScript = await harnessBuild.outputs[0].text();
		const workerScript = await workerBuild.outputs[0].text();
		const importHarnessScript = await importHarnessBuild.outputs[0].text();
		const realCoreBindings = await Bun.file(`${bindingsRoot}/index.js`).text();
		const realCoreWasm = await Bun.file(
			`${bindingsRoot}/index_bg.wasm`,
		).arrayBuffer();
		let state = freshState("success");
		let signedGrant:
			| {
					uploadUrl: string;
					requiredHeaders: Array<{ name: string; value: string }>;
			  }
			| undefined;
		const json = (value: unknown, init: ResponseInit = {}) =>
			Response.json(value, {
				...init,
				headers: { "access-control-allow-origin": "*", ...init.headers },
			});
		const networkFailure = () => {
			state.networkFailures += 1;
			return new Response(null, {
				headers: {
					"access-control-allow-origin": "*",
					"x-bittery-test-network-failure": "1",
				},
			});
		};
		const server = Bun.serve({
			port: 0,
			// The intentional held SSE response ends through Runtime cancellation or teardown.
			idleTimeout: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const userId =
					request.headers.get("authorization") ===
					"Bearer joined-second-session-token"
						? "user-2"
						: "user-1";
				const cors = {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
					"access-control-allow-headers": "*",
				};
				if (request.method === "OPTIONS")
					return new Response(null, { headers: cors });
				if (url.pathname === "/harness.js")
					return new Response(harnessScript, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/create-vault-worker.js")
					return new Response(workerScript, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/import-harness.js")
					return new Response(importHarnessScript, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/real-core-bindings.js")
					return new Response(realCoreBindings, {
						headers: { "content-type": "text/javascript" },
					});
				if (url.pathname === "/real-core.wasm")
					return new Response(realCoreWasm, {
						headers: { "content-type": "application/wasm" },
					});
				if (url.pathname === "/create-vault-observation") return json(state);
				const syncResponse = joinedSyncResponse(request, state);
				if (syncResponse) return syncResponse;

				const staging = url.pathname.match(
					/^\/api\/v1\/operations\/([^/]+)\/vault-image-staging(?:\/([^/]+))?$/,
				);
				if (staging) {
					const operationId = staging[1];
					const exchange = staging[2];
					const body = (await request.json()) as {
						vaultId: string;
						sha256: string;
					};
					const objectKey = `vaults/user-1/${body.vaultId}/create/${operationId}-${body.sha256}`;
					if (request.method === "DELETE") {
						state.routes.push("cleanup");
						state.cleanupCount += 1;
						if (state.mode === "rejection" || state.mode === "teardown")
							state.completed = true;
						return new Response(null, { status: 204, headers: cors });
					}
					state.routes.push(exchange ?? "staging");
					if (exchange === "status")
						return json(
							state.uploaded
								? {
										state: "confirmed",
										objectKey,
										generation: 1,
										leaseExpiresAt: "2026-09-02T00:00:00Z",
									}
								: { state: "absent" },
						);
					if (exchange === "grants")
						return json({
							objectKey,
							generation: 1,
							leaseExpiresAt: "2026-09-02T00:00:00Z",
							uploadUrl: signedGrant?.uploadUrl,
							uploadHeaders: signedGrant?.requiredHeaders,
						});
					if (exchange === "confirmations") {
						state.routes.push("confirmed");
						return json({
							state: "confirmed",
							objectKey,
							generation: 1,
							leaseExpiresAt: "2026-09-02T00:00:00Z",
						});
					}
				}

				if (request.method === "PUT" && !url.pathname.startsWith("/api/")) {
					state.routes.push("signed-upload");
					state.uploadAttempts += 1;
					const bytes = new Uint8Array(await request.arrayBuffer());
					const headersExact = signedGrant?.requiredHeaders.every(
						({ name, value }) =>
							name.toLowerCase() === "content-length"
								? request.headers.get(name) === String(bytes.byteLength)
								: request.headers.get(name) === value,
					);
					if (!headersExact || bytes.join(",") !== "1,2,3")
						return new Response(null, { status: 403, headers: cors });
					if (state.mode === "uploadFailures" && state.uploadAttempts <= 6)
						return new Response(null, { status: 503, headers: cors });
					state.uploaded = true;
					return new Response(null, { status: 200, headers: cors });
				}

				const importMatch = url.pathname.match(
					/^\/api\/v1\/vaults\/([^/]+)\/item-imports$/,
				);
				if (importMatch && request.method === "POST") {
					state.routes.push("import");
					state.importAttempts = (state.importAttempts ?? 0) + 1;
					const bytes = await request.text();
					state.importBodies ??= [];
					state.importBodies.push(bytes);
					const operationId = request.headers.get("idempotency-key") ?? "";
					state.importRequestIds ??= [];
					state.importRequestIds.push(operationId);
					state.importUsers ??= [];
					state.importUsers.push(userId);
					state.importDecisions ??= {};
					const retained = state.importDecisions[operationId];
					if (retained)
						return retained.body === bytes
							? json(retained.outcome)
							: json(
									{ error: { code: "OPERATION_ID_REUSED" } },
									{ status: 409 },
								);
					if (
						state.importRejectAfter !== undefined &&
						(state.importEffects ?? 0) >= state.importRejectAfter
					) {
						// Model permission loss between independently accepted batches. Retain
						// this decision without adding any of the rejected batch's Items.
						const outcome = {
							kind: "import_items",
							operationId,
							result: { status: "rejected", code: "vault_read_only" },
						};
						state.importDecisions[operationId] = { body: bytes, outcome };
						return json(outcome);
					}
					state.importEffects = (state.importEffects ?? 0) + 1;
					const body = JSON.parse(bytes) as {
						items: Array<Record<string, unknown>>;
					};
					state.importedItems = [
						...(state.importedItems ?? []),
						...body.items.map(({ itemId, ...item }) => ({
							...item,
							id: itemId,
							vaultId: importMatch[1],
							version: 1,
							encryptedByUserId: userId,
							lastModifiedBy: userId,
							encryptionVersion: 1,
							createdAt: "2026-09-01T00:00:00Z",
							updatedAt: "2026-09-01T00:00:00Z",
							deletedAt: null,
						})),
					];
					state.importOutcome = {
						kind: "import_items",
						operationId: request.headers.get("idempotency-key"),
						result: {
							status: "applied",
							vaultId: importMatch[1],
							importedCount: body.items.length,
						},
					};
					state.importDecisions[operationId] = {
						body: bytes,
						outcome: state.importOutcome,
					};
					// Drop the applied reply. Runtime must learn the durable outcome without another effect.
					return networkFailure();
				}
				if (
					/^\/api\/v1\/vaults\/[^/]+\/item-authority-pages$/.test(url.pathname)
				) {
					state.routes.push("item-authority");
					// Match the real Server's JSON extractor; accepting an untyped body here
					// hid a production 415 loop after an otherwise successful Import.
					if (request.headers.get("content-type") !== "application/json")
						return new Response(null, { status: 415, headers: cors });
					const body = (await request.json()) as {
						itemIds: string[];
						cursor: string | null;
					};
					const rows = (state.importedItems ?? []).filter((item) =>
						body.itemIds.includes(String(item.id)),
					);
					const start = body.cursor === null ? 0 : Number(body.cursor);
					return json(rows.slice(start, start + 2), {
						headers:
							start + 2 < rows.length
								? { "Bittery-Next-Cursor": String(start + 2) }
								: {},
					});
				}

				const operation = url.pathname.match(
					/^\/api\/v1\/operations\/([^/]+)$/,
				);
				if (operation && request.method === "GET") {
					state.routes.push("lookup");
					if (state.importDecisions?.[operation[1]])
						return json(state.importDecisions[operation[1]].outcome);
					return state.outcome?.operationId !== operation[1]
						? json({}, { status: 404 })
						: json(state.outcome);
				}
				const vaultMatch = url.pathname.match(/^\/api\/v1\/vaults\/([^/]+)$/);
				if (vaultMatch && request.method === "PUT") {
					state.routes.push("put");
					state.putAttempts += 1;
					if (state.mode === "lossBefore" && state.putAttempts === 1)
						return networkFailure();
					if (state.outcome !== undefined) return json(state.outcome);
					const body = (await request.json()) as Record<string, unknown>;
					state.putEffects += 1;
					if (state.mode !== "rejection") {
						state.encryptedVaultKey = String(body.encryptedVaultKey);
						state.vault = {
							id: vaultMatch[1],
							name: body.name,
							vaultType: body.vaultType === "shared" ? "team" : body.vaultType,
							icon: body.icon,
							imageUrl: body.imageKey === null ? null : "/image",
							userRole: "owner",
							itemCount: "0",
							memberCount: "1",
							createdAt: "2026-09-01T00:00:00Z",
						};
					}
					state.outcome = {
						kind: "create_vault",
						operationId: request.headers.get("idempotency-key"),
						result:
							state.mode === "rejection"
								? { status: "rejected", code: state.rejectionCode }
								: { status: "applied", vaultId: vaultMatch[1] },
					};
					state.rejected = state.mode === "rejection";
					if (state.mode === "lossAfter" && state.putAttempts === 1)
						return networkFailure();
					return json(state.outcome);
				}
				if (vaultMatch && request.method === "GET") {
					state.routes.push("vault-authority");
					return json(state.vault);
				}
				if (url.pathname === "/api/v1/users/me/vault-keys") {
					state.routes.push("key-authority");
					state.completed = true;
					return json({
						items: [
							{
								vaultId: state.vault?.id,
								vaultName: state.vault?.name,
								vaultType: state.vault?.vaultType,
								vaultIcon: state.vault?.icon,
								vaultImageUrl: state.vault?.imageUrl,
								role: "owner",
								encryptedVaultKey: state.encryptedVaultKey,
							},
						],
						hasMore: false,
						nextCursor: null,
					});
				}
				if (url.pathname.startsWith("/api/"))
					state.routes.push(`unhandled:${request.method}:${url.pathname}`);
				if (url.pathname === "/import")
					return new Response(
						'<script type="module" src="/import-harness.js"></script>',
						{ headers: { "content-type": "text/html" } },
					);
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			},
		});
		servers.push(server);
		const generated = spawnSync(
			"cargo",
			[
				"run",
				"--quiet",
				"--manifest-path",
				resolve(import.meta.dirname, "../../../apps/server/Cargo.toml"),
				"--features",
				"acceptance-adapter",
				"--bin",
				"presign-exact-upload-acceptance",
				"--",
				`http://127.0.0.1:${server.port}`,
			],
			{ encoding: "utf8" },
		);
		expect(generated.status, generated.stderr).toBe(0);
		signedGrant = JSON.parse(generated.stdout);

		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(() => "exerciseCreateVaultCase" in globalThis);
			const run = async (
				mode: Mode,
				options: Parameters<typeof globalThis.exerciseCreateVaultCase>[0],
				rejectionCode?: RejectionCode,
			) => {
				state = freshState(mode);
				state.rejectionCode = rejectionCode;
				return (await page.evaluate(
					async (input) => globalThis.exerciseCreateVaultCase(input),
					options,
				)) as {
					response: {
						type: string;
						value?: { type?: string; operationId?: string; vaultId?: string };
					};
					observation: ServerState;
					artifact?: { type?: string };
				};
			};

			for (const [name, vaultType] of [
				["Browser Personal", "personal"],
				["Browser Team", "shared"],
			] as const) {
				const result = await run("success", { name, vaultType });
				expect(result.response).toMatchObject({
					type: "succeeded",
					value: { type: "vaultCreationAccepted" },
				});
				expect(result.observation.vault?.name).toBe(name);
			}

			const image = await run("success", {
				name: "Browser Image",
				image: true,
			});
			expect(image.observation.routes).toContain("signed-upload");
			expect(image.observation.uploadAttempts).toBe(1);

			const cancelled = await run("success", {
				name: "Cancelled",
				image: true,
				cancelAfterSourceRead: true,
			});
			expect(cancelled.response.type).toBe("failed");
			expect(cancelled.observation.routes).toEqual([]);
			expect(cancelled).toMatchObject({
				reads: 1,
				closes: 1,
				artifactRows: 0,
				capabilityDiscarded: true,
			});

			for (const mode of ["lossBefore", "lossAfter"] as const) {
				const loss = await run(mode, { name: mode });
				expect(loss.observation.completed).toBe(true);
				expect(loss.observation.networkFailures).toBe(1);
				expect(loss.observation.outcome).toEqual({
					kind: "create_vault",
					operationId: loss.response.value?.operationId,
					result: {
						status: "applied",
						vaultId: loss.response.value?.vaultId,
					},
				});
				expect(loss.observation.putAttempts).toBe(2);
				expect(
					loss.observation.routes.filter((route) => route === "lookup"),
				).toHaveLength(2);
				expect(
					loss.observation.routes.filter(
						(route) => route === "vault-authority",
					),
				).toHaveLength(1);
				expect(
					loss.observation.routes.filter((route) => route === "key-authority"),
				).toHaveLength(1);
				if (mode === "lossBefore") {
					expect(loss.observation.putEffects).toBe(1);
				} else {
					expect(loss.observation.putEffects).toBe(1);
					expect(loss.observation.routes).toContain("lookup");
				}
			}

			for (const pause of [
				"artifactReady",
				"remoteUploadConfirmed",
				"finalRequestFrozen",
			] as const) {
				const restarted = await run("success", {
					name: `Restart ${pause}`,
					image: true,
					pause,
				});
				expect(restarted.observation.completed).toBe(true);
				expect(restarted.observation.uploadAttempts).toBe(1);
			}

			const retried = await run("uploadFailures", {
				name: "Retry Upload",
				image: true,
			});
			expect(retried.observation.uploadAttempts).toBe(7);
			expect(retried.observation.completed).toBe(true);

			for (const code of [
				"vault_id_conflict",
				"team_membership_required",
				"vault_sharing_entitlement_denied",
				"shared_vault_limit_reached",
			] as const) {
				const rejected = await run(
					"rejection",
					{ name: `Rejected ${code}`, image: true, vaultType: "shared" },
					code,
				);
				expect(rejected.observation.outcome).toEqual({
					kind: "create_vault",
					operationId: rejected.response.value?.operationId,
					result: { status: "rejected", code },
				});
				expect(rejected.observation.vault).toBeUndefined();
				expect(rejected.observation.encryptedVaultKey).toBeUndefined();
				expect(rejected.observation.putEffects).toBe(1);
				expect(rejected.observation.routes).not.toContain("vault-authority");
				expect(rejected.observation.routes).not.toContain("key-authority");
				expect(rejected.observation.cleanupCount).toBe(1);
				expect(rejected.artifact).toEqual({ type: "missing" });
			}

			const signedOut = await run("success", {
				name: "Sign-out Recovery",
				pause: "finalRequestFrozen",
				action: "signOut",
			});
			expect(signedOut.observation.completed).toBe(true);

			for (const action of ["removeAccount", "wipe"] as const) {
				const teardown = await run("teardown", {
					name: `${action} cleanup`,
					image: true,
					pause: "artifactReady",
					action,
				});
				expect(teardown.observation.cleanupCount).toBe(1);
				expect(teardown.artifact).toEqual({ type: "missing" });
			}

			state = freshState("success");
			const importPage = await browser.newPage();
			await importPage.goto(`http://127.0.0.1:${server.port}/import`);
			await importPage.waitForFunction(
				() => "exerciseJoinedRuntimeImportDefault" in globalThis,
			);
			const imported = await importPage.evaluate(() =>
				globalThis.exerciseJoinedRuntimeImportDefault(),
			);
			const acceptedTarget = imported.beforeRemount.targetVaultId;
			expect(acceptedTarget).toMatch(/^[0-9a-f-]{36}$/);
			expect(imported.beforeRemount.stage).toBe("completed");
			expect(imported.beforeRemount.error).toBeNull();
			expect(imported.beforeRemount.summary).toMatchObject({
				importedCount: 5,
				skippedCount: 0,
				createdVaultCount: 1,
				failedVaultCount: 0,
			});
			expect(imported.afterRemount).toEqual({
				stage: "idle",
				error: null,
				summary: null,
				targetVaultId: null,
			});
			expect(imported.legacyCalls).toBe(0);
			expect(imported.items).toHaveLength(5);
			expect(
				imported.items
					.map((item: { data: { category: string } }) => item.data.category)
					.sort(),
			).toEqual([
				"authenticator",
				"credit-card",
				"identity",
				"login",
				"secure-note",
			]);
			expect(
				imported.items.filter((item: { favorite: boolean }) => item.favorite),
			).toHaveLength(1);

			const importObservation = await waitForServerState(
				server.port,
				(value) => value.completed,
			);
			expect(importObservation.vault?.id).toBe(acceptedTarget);
			expect(importObservation.routes).toContain("put");
			expect(importObservation.importAttempts).toBe(2);
			expect(importObservation.importEffects).toBe(1);
			expect(importObservation.importBodies?.[1]).toBe(
				importObservation.importBodies?.[0],
			);
			expect(importObservation.networkFailures).toBe(1);
			expect(
				importObservation.routes.filter((route) => route === "item-authority"),
			).toHaveLength(3);

			await importPage.close();
			for (const scenario of [
				"existing",
				"later-rejection",
				"multi-account",
			] as const) {
				state = freshState("success");
				if (scenario === "later-rejection") state.importRejectAfter = 1;
				const scenarioPage = await browser.newPage();
				await scenarioPage.goto(
					`http://127.0.0.1:${server.port}/import${scenario === "multi-account" ? "?secondAccount=1" : ""}`,
				);
				await scenarioPage.waitForFunction(
					() => "exerciseJoinedRuntimeImportDefault" in globalThis,
				);
				const result = (await scenarioPage.evaluate(
					(selected) => globalThis.exerciseJoinedRuntimeImportDefault(selected),
					scenario,
				)) as typeof imported;
				const expectedCount = scenario === "later-rejection" ? 200 : 5;
				expect(result.beforeRemount.stage).toBe("completed");
				expect(result.beforeRemount.error).toBeNull();
				expect(result.beforeRemount.summary).toMatchObject({
					importedCount: expectedCount,
					skippedCount: scenario === "later-rejection" ? 1 : 0,
					createdVaultCount: scenario === "later-rejection" ? 1 : 0,
					failedVaultCount: scenario === "later-rejection" ? 1 : 0,
				});
				expect(result.items).toHaveLength(expectedCount);
				expect(
					new Set(
						result.items.map(
							(item: { data: { category: string } }) => item.data.category,
						),
					).size,
				).toBe(5);
				expect(
					result.items.filter((item: { favorite: boolean }) => item.favorite),
				).toHaveLength(1);
				expect(result.legacyCalls).toBe(0);
				expect(state.putEffects).toBe(1);
				expect(state.importEffects).toBe(1);
				expect(state.importedItems).toHaveLength(expectedCount);
				const decisions = Object.values(state.importDecisions ?? {});
				expect(decisions).toHaveLength(scenario === "later-rejection" ? 2 : 1);
				if (scenario !== "later-rejection")
					expect(result.beforeRemount.targetVaultId).toBe(
						result.existingVaultId,
					);
				else {
					expect(result.beforeRemount.summary?.failedVaults).toMatchObject([
						{ itemCount: 1 },
					]);
					expect(
						decisions.map(({ body }) => JSON.parse(body).items.length),
					).toEqual([200, 1]);
					expect(decisions[1].outcome).toMatchObject({
						result: { status: "rejected", code: "vault_read_only" },
					});
					expect(result.operations.state).toBe("ready");
					expect(
						result.operations.value.operations
							.filter(
								(operation: { kind: string }) =>
									operation.kind === "importItems",
							)
							.map(
								(operation: {
									resolution: string;
									importedCount: number | null;
								}) => ({
									resolution: operation.resolution,
									importedCount: operation.importedCount,
								}),
							)
							.sort(
								(left: { resolution: string }, right: { resolution: string }) =>
									left.resolution.localeCompare(right.resolution),
							),
					).toEqual([
						{ resolution: "applied", importedCount: 200 },
						{ resolution: "rejected", importedCount: null },
					]);
				}
				if (scenario === "multi-account") {
					expect(new Set(state.importUsers)).toEqual(new Set(["user-2"]));
					expect(
						result.items.every(
							(item: { accountId: string }) => item.accountId === "account-2",
						),
					).toBe(true);
					expect(result.activeAccountId).toBe("account-1");
					expect(result.activeAccountUnchanged).toBe(true);
				}
				await scenarioPage.close();
			}
		} finally {
			await browser.close();
		}
	}, 120_000);
});

function joinedImportModule(path: string): string {
	switch (path) {
		case "joined-runtime-client":
			return `
				const forward = (property) => (...args) => globalThis.__joinedRuntimeClient[property](...args);
				export const runtimeClient = Object.fromEntries([
					"signIn", "quickUnlock", "lock", "signOut", "removeAccount",
					"deleteServerAccount", "wipe", "createVault", "createItem", "importItems", "operations",
					"updateItem", "setItemFavorite", "trashItem", "restoreItem",
					"moveItem", "permanentlyDeleteItem", "renameAttachment",
					"deleteAttachment", "downloadAttachment", "uploadAttachment",
					"createShare", "acknowledgeShareResult", "items",
					"pendingShareResults", "writableVaults", "status", "session",
					"selectAccount",
				].map((property) => [property, forward(property)]));
			`;
		case "core-hooks":
			return `
				import { useSyncExternalStore } from "react";
				export const useAccountSwitcher = () => ({ activeAccount: useSyncExternalStore(
					(listener) => { globalThis.__runtimeImportAccountListeners.add(listener); return () => globalThis.__runtimeImportAccountListeners.delete(listener); },
					() => globalThis.__runtimeImportActiveAccount,
					() => null,
				) });
				export const useCoreContext = () => ({ accounts: {}, vaultRepository: {}, vaultCrypto: {} });
				export const usePlatformCrypto = () => ({});
			`;
		case "legacy-resolver":
			return `export const getClientForAccount = async () => { globalThis.__runtimeImportLegacyCalls += 1; throw new Error("legacy continuation reached"); };`;
		case "import-provider":
			return `
				export class ImportProviderError extends Error {}
				export const getImportProvider = (id) => id === "chrome" ? ({
					id: "chrome", title: "Chrome", canParse: () => true,
					parse: (file) => globalThis.__runtimeImportParse(file),
					toDecryptedItemData: item => item,
				}) : null;
			`;
		case "storage":
			return "export const itemCache = {}; export const storage = {};";
		case "i18n":
			return `export const useI18n = () => ({ m: {
				vaults_import_source_vault_no_folder: () => "No folder",
				vaults_import_source_vault_chrome_passwords: () => "Chrome passwords",
				vaults_import_source_vault_no_group: () => "No group",
			} });`;
		case "invalidator":
			return "export const useQueryInvalidator = () => ({});";
		default:
			throw new Error(`unknown joined Import module: ${path}`);
	}
}

async function waitForServerState(
	port: number,
	predicate: (value: ServerState) => boolean,
): Promise<ServerState> {
	const deadline = Date.now() + 35_000;
	let value = freshState("success");
	while (Date.now() < deadline) {
		value = (await fetch(
			`http://127.0.0.1:${port}/create-vault-observation`,
		).then((response) => response.json())) as ServerState;
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`joined Import create-Vault timed out: ${JSON.stringify(value)}`,
	);
}
