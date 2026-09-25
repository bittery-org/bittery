import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	type BrowserContext,
	chromium,
} from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
// Bun's repeated child-process DevTools pipe teardown can disconnect a later launch.
// Share only the browser process; every history keeps its own Worker and storage context.
let browserTask: ReturnType<typeof chromium.launch> | undefined;
function acceptanceBrowser() {
	browserTask ??= chromium.launch({ headless: false });
	return browserTask;
}
afterAll(async () => {
	try {
		await (await browserTask)?.close();
	} finally {
		for (const server of servers) await server.stop(true);
	}
});

type Mode =
	| "success"
	| "lossBefore"
	| "lossAfter"
	| "laterAuthority"
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
	notifySync?: () => void;
	requireFullRefresh?: boolean;
	completed: boolean;
	holdBootstrap?: boolean;
	vaultUserId?: string;
	rejected: boolean;
	cleanupCount: number;
	cleanupRequests: Array<{ userId: string; operationId: string; body: string }>;
	cleanedStagingKeys: string[];
	holdCleanupResponse?: boolean;
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
		cleanupRequests: [],
		cleanedStagingKeys: [],
		uploadAttempts: 0,
		putAttempts: 0,
		putEffects: 0,
		networkFailures: 0,
		uploaded: false,
	};
}

// These histories seed authority directly and exercise foreground Operations. Background
// Sync stays connected with no remote hints. Current authority refresh is served explicitly below.
function joinedSyncResponse(
	request: Request,
	state: ServerState,
): Response | undefined {
	if (request.method !== "GET") return undefined;
	const path = new URL(request.url).pathname;
	const headers = { "access-control-allow-origin": "*" };
	if (path === "/api/v1/sync/changes") {
		state.sync.changes += 1;
		const requiresFullRefresh = state.requireFullRefresh ?? false;
		state.requireFullRefresh = false;
		return Response.json(
			{ events: [], cursor: null, hasMore: false, requiresFullRefresh },
			{ headers },
		);
	}
	if (path !== "/api/v1/sync/events") return undefined;
	state.sync.opened += 1;
	let retire = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let active = true;
			const hint = () => {
				if (active)
					controller.enqueue(
						new TextEncoder().encode("event: sync\ndata: {}\n\n"),
					);
			};
			state.notifySync = hint;
			const abort = () => {
				retire();
				controller.close();
			};
			retire = () => {
				if (!active) return;
				active = false;
				if (state.notifySync === hint) state.notifySync = undefined;
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
		let releaseBootstrap: (() => void) | undefined;
		let releaseCleanupResponse: (() => void) | undefined;
		let snapshotNumber = 0;
		let invalidPolicyAuthorization = false;
		const snapshots = new Map<
			string,
			{
				userId: string;
				vaults: Record<string, unknown>[];
				items: Record<string, unknown>[];
			}
		>();
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
				if (
					url.pathname === "/allow-cleanup-response" &&
					request.method === "POST"
				) {
					state.holdCleanupResponse = false;
					releaseCleanupResponse?.();
					releaseCleanupResponse = undefined;
					return json({ released: true });
				}
				if (url.pathname === "/allow-bootstrap" && request.method === "POST") {
					state.holdBootstrap = false;
					releaseBootstrap?.();
					releaseBootstrap = undefined;
					return json({ released: true });
				}
				if (
					url.pathname === "/api/v1/travel-mode" &&
					request.method === "GET"
				) {
					const authorization = request.headers.get("authorization");
					if (
						authorization !== "Bearer joined-session-token" &&
						authorization !== "Bearer joined-second-session-token"
					) {
						invalidPolicyAuthorization = true;
						return json({}, { status: 401 });
					}
					state.routes.push("travel-policy");
					return json({
						enabled: false,
						enabledAt: null,
						hiddenVaultIds: [],
						updatedAt: "2023-11-14T22:13:20Z",
					});
				}
				if (
					url.pathname === "/api/v1/sync/bootstrap" &&
					request.method === "GET"
				) {
					if (state.holdBootstrap)
						await new Promise<void>((resolve) => {
							releaseBootstrap = resolve;
						});
					const phase = url.searchParams.get("phase");
					if (phase !== "vaults" && phase !== "items")
						return json({}, { status: 400 });
					let watermark = url.searchParams.get("syncCursor");
					if (watermark === null) {
						if (phase !== "vaults" || url.searchParams.has("cursor"))
							return json({}, { status: 400 });
						watermark = `snapshot-${++snapshotNumber}`;
						snapshots.set(watermark, {
							userId,
							vaults:
								state.vault !== undefined && state.vaultUserId === userId
									? [
											{
												id: state.vault.id,
												name: state.vault.name,
												vaultType: state.vault.vaultType,
												icon: state.vault.icon,
												imageUrl: state.vault.imageUrl,
												role: state.vault.userRole,
												encryptedVaultKey: state.encryptedVaultKey,
											},
										]
									: [],
							items: structuredClone(
								(state.importedItems ?? [])
									.filter((item) => item.encryptedByUserId === userId)
									.map((item) => ({ ...item, attachments: [] })),
							),
						});
					}
					const snapshot = snapshots.get(watermark);
					if (snapshot === undefined || snapshot.userId !== userId)
						return json({}, { status: 400 });
					const cursor = url.searchParams.get("cursor") ?? "0";
					if (!/^[0-9]+$/.test(cursor)) return json({}, { status: 400 });
					const start = Number(cursor);
					const rows = snapshot[phase];
					const next = start + 2;
					const hasMore = next < rows.length;
					state.routes.push(`bootstrap-${phase}`);
					if (phase === "items" && !hasMore) state.completed = true;
					return json({
						phase,
						[phase]: rows.slice(start, next),
						hasMore,
						nextCursor: hasMore ? String(next) : null,
						syncCursor: { id: watermark },
					});
				}
				const syncResponse = joinedSyncResponse(request, state);
				if (syncResponse) return syncResponse;

				const staging = url.pathname.match(
					/^\/api\/v1\/operations\/([^/]+)\/vault-image-staging(?:\/([^/]+))?$/,
				);
				if (staging) {
					const operationId = staging[1];
					const exchange = staging[2];
					const rawBody = await request.text();
					const body = JSON.parse(rawBody) as {
						vaultId: string;
						sha256: string;
					};
					const objectKey = `vaults/user-1/${body.vaultId}/create/${operationId}-${body.sha256}`;
					if (request.method === "DELETE") {
						state.routes.push("cleanup");
						state.cleanupCount += 1;
						state.cleanupRequests.push({ userId, operationId, body: rawBody });
						if (!state.cleanedStagingKeys.includes(objectKey))
							state.cleanedStagingKeys.push(objectKey);
						if (state.holdCleanupResponse && state.cleanupCount === 1)
							await new Promise<void>((resolve) => {
								releaseCleanupResponse = resolve;
							});
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
						state.vaultUserId = userId;
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
					if (state.mode === "laterAuthority" && state.vault !== undefined) {
						state.vault.name = "Renamed after creation";
						state.vault.vaultType = "team";
					}
					if (
						(state.mode === "lossAfter" || state.mode === "laterAuthority") &&
						state.putAttempts === 1
					)
						return networkFailure();
					return json(state.outcome);
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

		const browser = await acceptanceBrowser();
		const contexts: BrowserContext[] = [];
		const newPage = async () => {
			const page = await browser.newPage();
			contexts.push(page.context());
			return page;
		};
		try {
			const page = await newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await page.waitForFunction(() => "exerciseCreateVaultCase" in globalThis);
			const selectiveImages = await page.evaluate(() =>
				globalThis.exerciseSelectiveVaultImages(),
			);
			expect(selectiveImages).toEqual({
				retired: { type: "retired" },
				read: { type: "cancelled" },
				accepted: { type: "acceptanceBegun" },
				ended: { type: "acceptanceEnded" },
				otherClaim: { type: "claimed" },
				cleanedAtRetirement: ["account-1/visible", "account-1/hidden"],
				blocked: true,
				oldRejected: true,
				lateBytes: [0, 0, 0],
			});
			const run = async (
				mode: Mode,
				options: Parameters<typeof globalThis.exerciseCreateVaultCase>[0],
				rejectionCode?: RejectionCode,
			) => {
				state = freshState(mode);
				state.holdBootstrap = true;
				state.holdCleanupResponse = options.crashDuringCleanup;
				releaseBootstrap = undefined;
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
					cleanupBefore?: Record<string, unknown>;
					cleanupAfter?: Record<string, unknown>;
					receipt?: { operationId: string; resolution: string };
					authority?: { vaultId: string; name: string; vaultType: string };
					recoveryEvidence?: {
						classification: string;
						sameOperation: boolean;
						sameArtifacts: boolean;
						workerReplaced: boolean;
					};
				};
			};

			const protectedRecovery = await run("success", {
				name: "Protected recovery",
				image: true,
				pause: "artifactReady",
				protectedRecovery: true,
			});
			expect(protectedRecovery.recoveryEvidence).toMatchObject({
				classification: "complete",
				sameOperation: true,
				sameArtifacts: true,
				workerReplaced: true,
				retryStable: true,
				exactUpload: true,
				currentAuthority: true,
				lockedExport: true,
			});
			expect(protectedRecovery.observation.uploadAttempts).toBe(1);
			expect(protectedRecovery.observation.routes).toContain("travel-policy");
			expect(invalidPolicyAuthorization).toBe(false);

			const cleanupReplay = await run(
				"rejection",
				{
					name: "Lost cleanup response",
					image: true,
					vaultType: "shared",
					crashDuringCleanup: true,
				},
				"vault_id_conflict",
			);
			expect(cleanupReplay.observation.cleanupCount).toBe(2);
			expect(cleanupReplay.observation.cleanupRequests[1]).toEqual(
				cleanupReplay.observation.cleanupRequests[0],
			);
			expect(cleanupReplay.observation.cleanupRequests[0].operationId).toBe(
				cleanupReplay.response.value?.operationId,
			);
			expect(cleanupReplay.observation.cleanupRequests[0].userId).toBe(
				"user-1",
			);
			expect(
				JSON.parse(cleanupReplay.observation.cleanupRequests[0].body),
			).toMatchObject({
				vaultId: cleanupReplay.response.value?.vaultId,
				byteLength: 3,
				contentType: "image/png",
				sha256:
					"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			});
			expect(cleanupReplay.observation.cleanedStagingKeys).toHaveLength(1);
			expect(cleanupReplay.artifact).toEqual({ type: "missing" });
			expect(cleanupReplay.cleanupBefore?.createVaultCleanup).toMatchObject({
				localArtifactPending: false,
				remoteStagingPending: true,
			});
			expect(cleanupReplay.cleanupAfter?.createVaultCleanup).toBeUndefined();
			const { createVaultCleanup: _pendingCleanup, ...terminalEvidence } =
				cleanupReplay.cleanupBefore ?? {};
			void _pendingCleanup;
			// Only the cleanup obligation changes; exact original receipt evidence survives restart.
			expect(cleanupReplay.cleanupAfter).toEqual(terminalEvidence);

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
				expect(result.receipt).toMatchObject({
					operationId: result.response.value?.operationId,
					resolution: "applied",
				});
				expect(result.authority).toMatchObject({
					vaultId: result.response.value?.vaultId,
					name,
				});
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
						(route) => route === "bootstrap-vaults",
					),
				).toHaveLength(1);
				expect(
					loss.observation.routes.filter(
						(route) => route === "bootstrap-items",
					),
				).toHaveLength(1);
				if (mode === "lossBefore") {
					expect(loss.observation.putEffects).toBe(1);
				} else {
					expect(loss.observation.putEffects).toBe(1);
					expect(loss.observation.routes).toContain("lookup");
				}
			}

			const later = await run("laterAuthority", {
				name: "Original creation name",
			});
			expect(later.receipt).toMatchObject({
				operationId: later.response.value?.operationId,
				resolution: "applied",
			});
			expect(later.authority).toMatchObject({
				vaultId: later.response.value?.vaultId,
				name: "Renamed after creation",
				vaultType: "team",
			});
			expect(later.observation.putAttempts).toBe(2);
			expect(later.observation.putEffects).toBe(1);

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
				expect(rejected.observation.cleanupCount).toBeGreaterThanOrEqual(1);
				expect(rejected.observation.cleanedStagingKeys).toHaveLength(1);
				expect(
					new Set(
						rejected.observation.cleanupRequests.map((request) => request.body),
					).size,
				).toBe(1);
				expect(
					rejected.observation.cleanupRequests.every(
						(request) =>
							request.userId === "user-1" &&
							request.operationId === rejected.response.value?.operationId,
					),
				).toBe(true);
				expect(
					JSON.parse(rejected.observation.cleanupRequests[0].body),
				).toMatchObject({
					vaultId: rejected.response.value?.vaultId,
					byteLength: 3,
					contentType: "image/png",
					sha256:
						"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				});
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
			state.holdBootstrap = true;
			const importPage = await newPage();
			await importPage.goto(`http://127.0.0.1:${server.port}/import`);
			await importPage.waitForFunction(
				() => "exerciseJoinedRuntimeImportDefault" in globalThis,
			);
			const pendingImport = importPage
				.evaluate(() => globalThis.exerciseJoinedRuntimeImportDefault())
				.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
			await waitForServerState(server.port, (value) => value.putEffects === 1);
			await importPage.evaluate(async () => {
				const store = globalThis.__joinedRuntimeClient.operations("account-1");
				await new Promise<void>((resolve, reject) => {
					let release = () => {};
					const deadline = setTimeout(() => {
						release();
						reject(new Error("Import target receipt was not projected"));
					}, 35_000);
					const read = () => {
						const snapshot = store.getSnapshot();
						if (
							snapshot.state === "ready" &&
							snapshot.value.operations.some(
								(operation) => operation.resolution === "applied",
							)
						) {
							clearTimeout(deadline);
							release();
							resolve();
						}
					};
					release = store.subscribe(read);
					read();
				});
			});
			// Let the actual React continuation attempt its next step while the fresh authority
			// exchange remains held. Receipt projection alone must not force a premature batch.
			await importPage.evaluate(
				() =>
					new Promise<void>((resolve) => {
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
					}),
			);
			expect(state.importAttempts ?? 0).toBe(0);
			await fetch(`http://127.0.0.1:${server.port}/allow-bootstrap`, {
				method: "POST",
			});
			const settledImport = await pendingImport;
			if ("error" in settledImport) throw settledImport.error;
			const imported = settledImport.value;
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
				importObservation.routes.filter((route) => route === "bootstrap-items"),
			).toHaveLength(4);
			expect(importObservation.routes).not.toContain("item-authority");

			await importPage.close();
			for (const scenario of [
				"existing",
				"later-rejection",
				"multi-account",
			] as const) {
				state = freshState("success");
				if (scenario === "later-rejection") state.importRejectAfter = 1;
				const scenarioPage = await newPage();
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
			expect(invalidPolicyAuthorization).toBe(false);
		} finally {
			releaseCleanupResponse?.();
			await Promise.all(contexts.map((context) => context.close()));
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

// Auth/authority is seeded once; every artifact write, crash, ordinary Runtime.open, selective
// cleanup and subsequent read uses the actual combined Worker and Chromium IndexedDB.
test("retirement survives Worker loss and selectively sweeps real IndexedDB Move artifacts", async () => {
	const builds = await Promise.all(
		[
			"web-vault-retirement-chromium-harness.ts",
			"web-create-vault-worker.ts",
		].map((file) =>
			Bun.build({
				entrypoints: [new URL(file, import.meta.url).pathname],
				target: "browser",
				format: "esm",
			}),
		),
	);
	for (const build of builds) expect(build.success).toBe(true);
	const [harness, worker] = await Promise.all(
		builds.map((build) => build.outputs[0].text()),
	);
	const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!bindingsRoot) throw new Error("Joined Runtime bindings are required");
	let history:
		| {
				accountId: string;
				operationId: string;
				retained: string[];
				garbage: string[];
				unrelated: string[];
				sourceVaultId: string;
		  }
		| undefined;
	const unexpected: string[] = [];
	const sync = freshState("success");
	let seededWorkerRetired = false;
	let seedError: string | undefined;
	let openError: string | undefined;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (!seededWorkerRetired) {
				const stream = joinedSyncResponse(request, sync);
				if (stream !== undefined) return stream;
			}
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			if (path === "/harness.js")
				return new Response(harness, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/create-vault-worker.js")
				return new Response(worker, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${bindingsRoot}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${bindingsRoot}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			if (path === "/retirement-history" && request.method === "POST") {
				history = await request.json();
				return new Response(null, { status: 204 });
			}
			if (path === "/retirement-open-error" && request.method === "POST") {
				openError = await request.text();
				return new Response(null, { status: 204 });
			}
			if (path === "/retirement-seed-error" && request.method === "POST") {
				seedError = await request.text();
				return new Response(null, { status: 204 });
			}
			unexpected.push(`${request.method} ${path}`);
			return new Response("unexpected fixture route", { status: 500 });
		},
	});
	servers.push(server);
	const browser = await acceptanceBrowser();
	const context = await browser.newContext();
	let page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(server.url.toString());
		await page.waitForFunction(
			() => typeof (globalThis as any).retirementSeed === "function",
		);
		await page.evaluate(() => (globalThis as any).retirementSeed());
		const deadline = Date.now() + 30_000;
		while (!history && !seedError && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		if (!history)
			throw new Error(
				`Seed failed: ${JSON.stringify({ errors, unexpected, seedError })}`,
			);
		const seeded = history;
		const before = await page.evaluate(() =>
			(globalThis as any).retirementSnapshot(),
		);
		// The seeded, authorized Worker performs ordinary catch-up alongside its live stream.
		// Observe that path before retiring it; restored signed-out Workers may use neither route.
		while (sync.sync.changes === 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sync.sync.opened).toBeGreaterThan(0);
		expect(sync.sync.changes).toBeGreaterThan(0);
		seededWorkerRetired = true;
		await page.evaluate(() => (globalThis as any).retirementKill());
		await page.close();
		page = await context.newPage();
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(server.url.toString());
		await page.waitForFunction(
			() => typeof (globalThis as any).retirementRestart === "function",
		);
		// Closing the original tab also discards its SessionSecret storage. Device storage and
		// IndexedDB persist in this same browser context; startup must finish without retained access material.
		expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
		const after = await page
			.evaluate(() => (globalThis as any).retirementRestart())
			.catch((error) => {
				throw new Error(`${String(error)}; Core open: ${openError}`);
			});
		expect(after.status.type).toBe("runtimeStatus");
		expect(after.status.value.accounts).toHaveLength(1);
		expect(after.status.value.accounts[0].accountId).toBe("account-1");
		expect(after.status.value.accounts[0].access).toBe("signedOut");
		const rows = (value: any, store: string) =>
			value.artifacts.find((entry: any) => entry.store === store).rows;
		const ownerRows = (value: any) => rows(value, "artifacts");
		expect(
			ownerRows(before)
				.map((row: any) => row.artifactId)
				.sort(),
		).toEqual(
			[...seeded.retained, ...seeded.garbage, ...seeded.unrelated].sort(),
		);
		expect(
			ownerRows(after)
				.map((row: any) => row.artifactId)
				.sort(),
		).toEqual([...seeded.retained, ...seeded.unrelated].sort());
		for (const store of before.artifacts.map((entry: any) => entry.store)) {
			const expected = rows(before, store).filter(
				(row: any) => !seeded.garbage.includes(row.artifactId),
			);
			expect(rows(after, store)).toEqual(expected);
		}
		const preparation = (value: any) =>
			value.replica.rows.filter(
				(row: any) => row.store === "attachmentMovePreparations",
			);
		expect(preparation(before)).toHaveLength(1);
		expect(
			JSON.parse(preparation(before)[0].payloadJson).progress.map(
				(entry: any) => entry.type,
			),
		).toEqual(["encrypted", "pending"]);
		expect(
			rows(before, "provisional_chunks").some(
				(row: any) => row.bytes.byteLength === 256 * 1024,
			),
		).toBe(true);
		expect(
			before.replica.rows.some(
				(row: any) =>
					row.store === "authorityVaults" &&
					JSON.parse(row.payloadJson).id === seeded.sourceVaultId,
			),
		).toBe(true);
		expect(
			after.replica.rows.some(
				(row: any) =>
					row.store === "authorityVaults" &&
					JSON.parse(row.payloadJson).id === "vault-target",
			),
		).toBe(true);
		expect(preparation(after)).toEqual(preparation(before));
		expect(
			after.replica.rows.some(
				(row: any) =>
					row.store === "replicaMetadata" &&
					row.key.recordId === "vault-retirements",
			),
		).toBe(false);
		expect(
			after.replica.rows
				.filter((row: any) =>
					["authorityItems", "authorityVaults"].includes(row.store),
				)
				.every((row: any) => {
					const payload = JSON.parse(row.payloadJson);
					return (
						payload.vaultId !== seeded.sourceVaultId &&
						payload.id !== seeded.sourceVaultId
					);
				}),
		).toBe(true);
		const reopened = await page.evaluate(() =>
			(globalThis as any).retirementRestart(),
		);
		expect(reopened.replica).toEqual(after.replica);
		expect(reopened.artifacts).toEqual(after.artifacts);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(sync.sync.cancelled).toBe(sync.sync.opened);
		await page.evaluate(() => (globalThis as any).retirementClose());
	} finally {
		await context.close();
	}
}, 120_000);

// The real Core owns the fixed snapshot; the existing Worker channel carries its terminal
// control while public Lock is held on host cleanup, including a zero-Attachment Export.
async function joinedExportRetirement(
	mode:
		| "lock"
		| "close"
		| "loss"
		| "storeLoss"
		| "output"
		| "outputClose"
		| "callbackThrow",
) {
	const builds = await Promise.all(
		["web-vault-export-chromium-harness.ts", "web-create-vault-worker.ts"].map(
			(file) =>
				Bun.build({
					entrypoints: [new URL(file, import.meta.url).pathname],
					target: "browser",
					format: "esm",
				}),
		),
	);
	for (const build of builds) expect(build.success).toBe(true);
	const [harness, worker] = await Promise.all(
		builds.map((build) => build.outputs[0].text()),
	);
	const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!bindingsRoot) throw new Error("Joined Runtime bindings are required");
	const unexpected: string[] = [];
	const sync = freshState("success");
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const path = new URL(request.url).pathname;
			const stream = joinedSyncResponse(request, sync);
			if (stream !== undefined) return stream;
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			if (path === "/harness.js" || path === "/create-vault-worker.js")
				return new Response(path === "/harness.js" ? harness : worker, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${bindingsRoot}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${bindingsRoot}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			unexpected.push(`${request.method} ${path}`);
			return new Response("unexpected fixture route", { status: 500 });
		},
	});
	servers.push(server);
	const browser = await acceptanceBrowser();
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(server.url.toString());
		await page.waitForFunction(
			() => typeof (globalThis as any).exerciseExportLock === "function",
		);
		const result = await page.evaluate(
			(action) =>
				action === "callbackThrow"
					? (globalThis as any).exerciseExportCallbackThrow()
					: action === "outputClose"
						? (globalThis as any).exerciseExportOutputClose()
						: action === "output"
							? (globalThis as any).exerciseExportOutput()
							: action === "storeLoss"
								? (globalThis as any).exerciseItemsOwnerLoss()
								: action === "loss"
									? (globalThis as any).exerciseExportOwnerLoss()
									: action === "close"
										? (globalThis as any).exerciseExportClose()
										: (globalThis as any).exerciseExportLock(),
			mode,
		);
		expect(result.itemCount).toBe(1);
		expect(result.attachmentCount).toBe(0);
		if (mode === "output" || mode === "outputClose") {
			expect(result.outputBytes).toBeGreaterThan(0);
			expect(result.beginError).toBeNull();
			expect(result.forwardingWitnesses).toEqual([
				"before:refused",
				"after:refused",
			]);
			expect(result.wrongLeaseRejected).toBe(true);
			expect(result.lockFinishedAfterWrongLease).toBe(false);
		}
		if (mode === "storeLoss") {
			expect(result.workerErrors).toBe(1);
			expect(result.terminations).toBe(1);
			expect(errors).toEqual([]);
			expect(unexpected).toEqual([]);
			expect(result.storeAtTermination).toEqual({
				state: "failed",
				hasData: false,
				code: "INVARIANT_VIOLATION",
			});
			return;
		}
		if (mode === "loss") {
			expect(result.workerErrors).toBe(1);
			expect(result.terminations).toBe(1);
			expect(errors).toEqual([]);
			expect(unexpected).toEqual([]);
			expect({
				controls: result.controls,
				retainedSnapshotAtTermination: result.retainedSnapshotAtTermination,
			}).toEqual({
				controls: [{ type: "vaultExportRetired", reason: "connectionClosed" }],
				retainedSnapshotAtTermination: false,
			});
			return;
		}
		if (mode === "callbackThrow") {
			expect(result.callbackThrows).toBe(1);
			expect(result.beginAfterThrowRejected).toBe(true);
			expect(result.rawControls).toBe(0);
		} else expect(result.rawControls).toBe(1);
		expect(result.retainedSnapshot).toBe(true);
		expect(result.lockFinishedBeforeCleanup).toBe(false);
		expect(result.controls).toEqual(
			mode === "callbackThrow"
				? []
				: [
						{
							type: "vaultExportRetired",
							reason:
								mode === "close" || mode === "outputClose"
									? "runtimeClosed"
									: "scopeRetired",
						},
					],
		);
		expect(result.cleanupError).toBeNull();
		expect(result.forcedTermination).toBe(false);
		expect(result.lockFinished).toBe(true);
		if (mode === "lock" || mode === "output" || mode === "callbackThrow") {
			expect(result.response.type).toBe("succeeded");
			expect(result.response.value).toEqual({
				type: "accessChanged",
				accountId: "account-1",
				access: "locked",
			});
		} else {
			expect(result.terminations).toBe(1);
			expect(result.response).toBeNull();
		}
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(sync.sync.cancelled).toBe(sync.sync.opened);
	} finally {
		await context.close();
		await server.stop(true);
	}
}

test(
	"joined Worker Export delivers Lock retirement before host snapshot cleanup",
	() => joinedExportRetirement("lock"),
	120_000,
);
test(
	"joined Worker Export permits cleanup acknowledgement during Close",
	() => joinedExportRetirement("close"),
	120_000,
);

test(
	"joined Worker Export retires its idle host snapshot on abrupt owner loss",
	() => joinedExportRetirement("loss"),
	120_000,
);

test(
	"joined Worker Items store drops stale plaintext on abrupt owner loss",
	() => joinedExportRetirement("storeLoss"),
	120_000,
);

test(
	"joined Worker Export output lease holds Lock until its exact Finish",
	() => joinedExportRetirement("output"),
	120_000,
);

test(
	"joined Worker Export output permits exact Finish during Close",
	() => joinedExportRetirement("outputClose"),
	120_000,
);

let archiveScripts: Promise<[string, string]> | undefined;
function archiveAcceptanceScripts() {
	archiveScripts ??= (async () => {
		const builds = await Promise.all([
			Bun.build({
				entrypoints: [
					new URL("web-vault-archive-chromium-harness.tsx", import.meta.url)
						.pathname,
				],
				target: "browser",
				format: "esm",
				plugins: [
					{
						name: "same-joined-archive-composition",
						setup(build) {
							build.onResolve({ filter: /^@\// }, ({ path }) => ({
								path:
									path === "@/lib/crypto"
										? new URL(
												"web-vault-archive-composition.ts",
												import.meta.url,
											).pathname
										: Bun.resolveSync(
												new URL(
													`../../../apps/web/src/${path.slice(2)}`,
													import.meta.url,
												).pathname,
												import.meta.dir,
											),
							}));
						},
					},
				],
			}),
			Bun.build({
				entrypoints: [
					new URL("web-create-vault-worker.ts", import.meta.url).pathname,
				],
				target: "browser",
				format: "esm",
			}),
		]);
		for (const build of builds) {
			if (!build.success)
				throw new AggregateError(
					build.logs,
					"Archive acceptance assembly failed",
				);
		}
		const [harness, worker] = await Promise.all(
			builds.map((build) => build.outputs[0].text()),
		);
		return [harness, worker] as [string, string];
	})();
	return archiveScripts;
}

async function withVaultArchive(
	withAttachment: boolean,
	exercise: (fixture: {
		page: import("../../../apps/extension/node_modules/playwright/index.mjs").Page;
		original: { selectedVaultId: string; vaultIds: string[] };
		hide(): void;
		readmit(): void;
		refreshAuthority(): void;
		holdDownload(): void;
		releaseDownload(): void;
		downloadReads(): number;
		downloadGrants(): number;
	}) => Promise<void>,
) {
	const [harness, worker] = await archiveAcceptanceScripts();
	const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!bindingsRoot) throw new Error("Joined Runtime bindings are required");
	const state = freshState("success");
	const unexpected: string[] = [];
	let hiddenVaultIds: string[] = [];
	let itemAuthority: Record<string, unknown> | undefined;
	let attachmentAuthority: Record<string, unknown> | undefined;
	let ciphertext: ArrayBuffer | undefined;
	let reads = 0;
	let grants = 0;
	let authority:
		| { vaults: Record<string, unknown>[]; items: Record<string, unknown>[] }
		| undefined;
	let snapshotNumber = 0;
	const bootstrapSnapshots = new Map<string, NonNullable<typeof authority>>();
	let downloadGate: Promise<void> | undefined;
	let releaseDownload = () => {};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			state.routes.push(`${request.method} ${path}${url.search}`);
			const stream = joinedSyncResponse(request, state);
			if (stream !== undefined) return stream;
			if (
				path.startsWith("/api/v1/") &&
				request.headers.get("authorization") !== "Bearer joined-session-token"
			) {
				unexpected.push("invalid archive authorization");
				return new Response(null, { status: 401 });
			}
			if (path === "/api/v1/travel-mode" && request.method === "GET") {
				return Response.json({
					enabled: hiddenVaultIds.length > 0,
					enabledAt: hiddenVaultIds.length > 0 ? "2023-11-14T22:13:20Z" : null,
					hiddenVaultIds,
					updatedAt: "2023-11-14T22:13:20Z",
				});
			}
			if (
				path === "/api/v1/sync/bootstrap" &&
				request.method === "GET" &&
				authority
			) {
				const phase = url.searchParams.get("phase");
				if (phase !== "vaults" && phase !== "items")
					throw new Error("Unknown archive Bootstrap phase");
				let cursor = url.searchParams.get("syncCursor");
				if (cursor === null && phase === "vaults") {
					cursor = `archive-snapshot-${++snapshotNumber}`;
					bootstrapSnapshots.set(
						cursor,
						structuredClone({
							vaults: authority.vaults.filter(
								(row) => !hiddenVaultIds.includes(String(row.id)),
							),
							items: authority.items.filter(
								(row) => !hiddenVaultIds.includes(String(row.vaultId)),
							),
						}),
					);
				}
				const snapshot =
					cursor === null ? undefined : bootstrapSnapshots.get(cursor);
				if (!snapshot) throw new Error("Unknown archive Bootstrap snapshot");
				return Response.json({
					phase,
					[phase]: snapshot[phase],
					hasMore: false,
					nextCursor: null,
					syncCursor: { id: cursor },
				});
			}
			if (withAttachment) {
				if (path === "/archive-item-authority" && request.method === "POST") {
					itemAuthority = (await request.json()) as Record<string, unknown>;
					return Response.json({ seeded: true });
				}
				if (path.endsWith("/attachment-uploads") && request.method === "POST")
					return Response.json({
						attachmentId: "archive-attachment",
						key: "attachments/archive",
						uploadUrl: `${url.origin}/archive-binary`,
					});
				if (path === "/archive-binary" && request.method === "PUT") {
					ciphertext = await request.arrayBuffer();
					return new Response(null, { status: 200 });
				}
				if (path.endsWith("/attachments") && request.method === "POST") {
					const metadata = (await request.json()) as Record<string, unknown>;
					attachmentAuthority = {
						id: metadata.attachmentId,
						itemId: "item-existing",
						vaultId: "vault-1",
						storageKey: metadata.storageKey,
						encryptedName: metadata.encryptedName,
						encryptionIv: metadata.encryptionIv,
						encryptionAlgorithm: metadata.encryptionAlgorithm,
						encryptedAttachmentKey: metadata.encryptedAttachmentKey,
						attachmentKeyIv: metadata.attachmentKeyIv,
						attachmentKeyAlgorithm: metadata.attachmentKeyAlgorithm,
						encryptedContentType: metadata.encryptedContentType,
						encryptedContentTypeIv: metadata.encryptedContentTypeIv,
						envelopeVersion: metadata.envelopeVersion,
						fileSize: metadata.fileSize,
						uploadedBy: "user-1",
						createdAt: "2026-08-30T00:00:00Z",
					};
					return Response.json({ attachmentId: "archive-attachment" });
				}
				if (path.endsWith("/items/item-existing") && request.method === "GET")
					return Response.json(itemAuthority);
				if (path.endsWith("/attachments") && request.method === "GET")
					return Response.json({
						items: attachmentAuthority ? [attachmentAuthority] : [],
						hasMore: false,
						nextCursor: null,
					});
				if (path.endsWith("/download-urls") && request.method === "POST") {
					grants += 1;
					return Response.json({
						attachmentId: "archive-attachment",
						itemId: attachmentAuthority?.itemId,
						vaultId: attachmentAuthority?.vaultId,
						storageKey: attachmentAuthority?.storageKey,
						envelopeVersion: attachmentAuthority?.envelopeVersion,
						uploadedBy: attachmentAuthority?.uploadedBy,
						encryptedName: attachmentAuthority?.encryptedName,
						encryptedContentType: attachmentAuthority?.encryptedContentType,
						encryptionIv: attachmentAuthority?.encryptionIv,
						encryptedContentTypeIv: attachmentAuthority?.encryptedContentTypeIv,
						encryptionAlgorithm: attachmentAuthority?.encryptionAlgorithm,
						fileSize: attachmentAuthority?.fileSize,
						downloadUrl: `${url.origin}/archive-binary`,
					});
				}
				if (path === "/archive-binary" && request.method === "GET") {
					reads += 1;
					await downloadGate;
					if (!ciphertext)
						throw new Error("Real Attachment ciphertext is missing");
					return new Response(ciphertext);
				}
			}
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{ headers: { "content-type": "text/html" } },
				);
			if (path === "/harness.js" || path === "/create-vault-worker.js")
				return new Response(path === "/harness.js" ? harness : worker, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${bindingsRoot}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${bindingsRoot}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			unexpected.push(`${request.method} ${path}`);
			return new Response("unexpected archive route", { status: 500 });
		},
	});
	servers.push(server);
	const context = await (await acceptanceBrowser()).newContext({
		acceptDownloads: true,
	});
	try {
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${server.url}?attachment=${withAttachment ? "1" : "0"}`);
		await page.waitForFunction(
			() => typeof (globalThis as any).initializeVaultArchive === "function",
		);
		const original = await page.evaluate(() =>
			(globalThis as any).initializeVaultArchive(),
		);
		expect(original.workersCreated).toBe(1);
		expect(original.vaultIds).toContain(original.selectedVaultId);
		if (withAttachment)
			await page.evaluate(() =>
				(globalThis as any).uploadVaultArchiveAttachment(),
			);
		// The fixture Server keeps only original encrypted authority. Re-admission still
		// goes through authenticated Core Bootstrap after the physical local erasure.
		authority = await page.evaluate(() =>
			(globalThis as any).captureVaultArchiveEncryptedAuthority(),
		);
		await exercise({
			page,
			original,
			hide() {
				hiddenVaultIds = [original.selectedVaultId];
			},
			readmit() {
				hiddenVaultIds = [];
			},
			refreshAuthority() {
				state.requireFullRefresh = true;
				state.notifySync?.();
			},
			holdDownload() {
				downloadGate = new Promise<void>((resolve) => {
					releaseDownload = resolve;
				});
			},
			releaseDownload() {
				releaseDownload();
				downloadGate = undefined;
			},
			downloadReads: () => reads,
			downloadGrants: () => grants,
		}).catch(async (failure) => {
			const projection = await page.evaluate(() => {
				const snapshot = (globalThis as any).vaultArchiveItems();
				return {
					state: snapshot.state,
					items: snapshot.value?.items.length,
					vaultIds: snapshot.value?.vaults.map(
						(vault: { vaultId: string }) => vault.vaultId,
					),
				};
			});
			throw new Error(
				`${String(failure)}; archive fixture: ${JSON.stringify({ requests: state.routes, sync: state.sync, authorityVaults: authority?.vaults.length, authorityItems: authority?.items.length, projection })}`,
			);
		});
		await page.evaluate(() => (globalThis as any).closeVaultArchive());
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
	} finally {
		releaseDownload();
		await context.close();
		await server.stop(true);
	}
}

for (const withAttachment of [false, true]) {
	test(`actual Web archive hook preserves output and retires ready Blob with ${withAttachment ? 1 : 0} Attachments`, async () => {
		await withVaultArchive(
			withAttachment,
			async ({ page, original, hide, downloadGrants }) => {
				await page.evaluate(() => (globalThis as any).startVaultArchive());
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveSnapshot()),
				).toEqual({ ready: true, stage: "completed" });
				let firstItems: unknown;
				for (let output = 0; output < 2; output += 1) {
					const downloaded = page.waitForEvent("download");
					await page.locator("#archive-download").click();
					const download = await downloaded;
					expect(download.suggestedFilename()).toBe("bittery-export.bttrx");
					const downloadPath = await download.path();
					if (!downloadPath) throw new Error("Real browser output is missing");
					const { default: JSZip } = await import(
						"../../../apps/web/node_modules/jszip"
					);
					const zip = await JSZip.loadAsync(
						await Bun.file(downloadPath).arrayBuffer(),
					);
					const entry = zip.file("export.json");
					if (!entry) throw new Error("Real archive export.json is missing");
					const payload = JSON.parse(await entry.async("string"));
					expect(payload.version).toBe("1");
					expect(payload.items).toHaveLength(1);
					expect(payload.items[0].data.title).toBe("Joined Upload Item");
					expect(payload.items[0].vaultId).toBe(original.selectedVaultId);
					if (withAttachment) {
						const bytes = new Uint8Array(140_000).map(
							(_, index) => index % 256,
						);
						const attachment = zip.file("files/item-existing/résumé.bin");
						if (!attachment)
							throw new Error("Real Attachment ZIP entry is missing");
						expect(await attachment.async("uint8array")).toEqual(bytes);
						expect(payload.items[0].attachments).toEqual([
							{
								filename: "résumé.bin",
								contentType: "application/octet-stream",
								data: Buffer.from(bytes).toString("base64"),
							},
						]);
					} else expect(payload.items[0].attachments).toEqual([]);
					if (output === 0) firstItems = payload.items;
					else expect(payload.items).toEqual(firstItems);
					await page.waitForFunction(
						() => (globalThis as any).vaultArchiveSnapshot().ready,
					);
				}
				expect(
					await page.evaluate(() =>
						(globalThis as any).vaultArchiveCaptureCount(),
					),
				).toBe(2);
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
				).toMatchObject({ urlsCreated: 2, urlsRevoked: 2, liveUrls: 0 });
				expect(downloadGrants()).toBe(withAttachment ? 2 : 0);
				await page.evaluate(() => (globalThis as any).startVaultArchive());
				hide();
				const retired = await page.evaluate(() =>
					(globalThis as any).refreshVaultArchivePolicy(),
				);
				expect(retired.result.type).toBe("succeeded");
				expect(retired.accountUnlocked).toBe(true);
				expect(retired.items).toBe(0);
				expect(retired.vaultIds).toEqual(
					original.vaultIds.filter(
						(id: string) => id !== original.selectedVaultId,
					),
				);
				expect(retired.ready).toBe(false);
				expect(
					await page.evaluate(() =>
						(globalThis as any).tryVaultArchiveDownload(),
					),
				).toEqual({ outputs: 0 });
			},
		);
	}, 120_000);

	test(`actual Web archive hide and readmit cannot revive old output with ${withAttachment ? 1 : 0} Attachments`, async () => {
		await withVaultArchive(
			withAttachment,
			async ({ page, original, hide, readmit, refreshAuthority }) => {
				await page.evaluate(() => (globalThis as any).startVaultArchive());
				hide();
				expect(
					await page.evaluate(() =>
						(globalThis as any).refreshVaultArchivePolicy(),
					),
				).toMatchObject({ ready: false, items: 0 });
				readmit();
				expect(
					await page.evaluate(() =>
						(globalThis as any).refreshVaultArchivePolicy(),
					),
				).toMatchObject({ result: { type: "succeeded" }, ready: false });
				refreshAuthority();
				await page.waitForFunction((vaultId) => {
					const store = (globalThis as any).vaultArchiveItems();
					return (
						store.state === "ready" &&
						store.value.items.some(
							(item: { vaultId: string }) => item.vaultId === vaultId,
						)
					);
				}, original.selectedVaultId);
				expect(
					await page.evaluate(() =>
						(globalThis as any).tryVaultArchiveDownload(),
					),
				).toEqual({ outputs: 0 });
				await page.evaluate(() => (globalThis as any).startVaultArchive());
				const downloaded = page.waitForEvent("download");
				await page.locator("#archive-download").click();
				await downloaded;
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveSnapshot().ready,
				);
				expect(
					await page.evaluate(() =>
						(globalThis as any).vaultArchiveCaptureCount(),
					),
				).toBe(2);
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
				).toMatchObject({ urlsCreated: 1, urlsRevoked: 1, liveUrls: 0 });
			},
		);
	}, 120_000);

	for (const phase of [
		"zip",
		"beforeOutput",
		"admittedOutput",
		"finishOutput",
	] as const) {
		test(`actual Web archive hide drains ${phase} with ${withAttachment ? 1 : 0} Attachments`, async () => {
			await withVaultArchive(withAttachment, async ({ page, hide }) => {
				if (phase !== "zip")
					await page.evaluate(() => (globalThis as any).startVaultArchive());
				await page.evaluate((phase) => {
					(globalThis as any).holdVaultArchive(phase);
					(globalThis as any).queueVaultArchiveAction(
						phase === "zip" ? "start" : "download",
					);
				}, phase);
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveLifetime().gateReached,
				);
				hide();
				await page.evaluate(() =>
					(globalThis as any).queueVaultArchiveRetirement("hide"),
				);
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveLifetime().retirements === 1,
				);
				const held = await page.evaluate(() =>
					(globalThis as any).vaultArchiveLifetime(),
				);
				expect(held).toMatchObject({
					ready: false,
					stage: "idle",
					activeTaskSettled: false,
					retirementSettled: false,
					cleanupAcknowledgements: 0,
					urlsCreated: phase === "finishOutput" ? 1 : 0,
					urlsRevoked: phase === "finishOutput" ? 1 : 0,
					liveUrls: 0,
				});
				await page.evaluate(() => {
					(globalThis as any).releaseVaultArchive();
					return (globalThis as any).settleVaultArchive();
				});
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
				).toMatchObject({
					ready: false,
					stage: "idle",
					activeTaskSettled: true,
					retirementSettled: true,
					retirementResult: {
						result: { type: "succeeded" },
						accountUnlocked: true,
						items: 0,
					},
					urlsCreated: phase === "finishOutput" ? 1 : 0,
					liveUrls: 0,
				});
				expect(
					await page.evaluate(() =>
						(globalThis as any).tryVaultArchiveDownload(),
					),
				).toEqual({ outputs: 0 });
			});
		}, 120_000);
	}

	for (const retirement of ["close", "loss", "reset"] as const) {
		test(`actual Web archive ${retirement} retires ready Blob with ${withAttachment ? 1 : 0} Attachments`, async () => {
			await withVaultArchive(withAttachment, async ({ page }) => {
				await page.evaluate(() => (globalThis as any).startVaultArchive());
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveSnapshot()),
				).toMatchObject({ ready: true });
				await page.evaluate(
					(kind) => (globalThis as any).queueVaultArchiveRetirement(kind),
					retirement,
				);
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveSnapshot().stage === "idle",
				);
				await page.evaluate(() => (globalThis as any).settleVaultArchive());
				expect(
					await page.evaluate(() =>
						(globalThis as any).tryVaultArchiveDownload(),
					),
				).toEqual({ outputs: 0 });
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
				).toMatchObject({ ready: false, liveUrls: 0, urlsCreated: 0 });
			});
		}, 120_000);

		test(`actual Web archive ${retirement} drains held ZIP with ${withAttachment ? 1 : 0} Attachments`, async () => {
			await withVaultArchive(withAttachment, async ({ page }) => {
				await page.evaluate(() => {
					(globalThis as any).holdVaultArchive("zip");
					(globalThis as any).queueVaultArchiveAction("start");
				});
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveLifetime().gateReached,
				);
				await page.evaluate(
					(kind) => (globalThis as any).queueVaultArchiveRetirement(kind),
					retirement,
				);
				await page.waitForFunction(
					() => (globalThis as any).vaultArchiveSnapshot().stage === "idle",
				);
				expect(
					await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
				).toMatchObject({
					ready: false,
					activeTaskSettled: false,
					cleanupAcknowledgements: 0,
					urlsCreated: 0,
					liveUrls: 0,
				});
				await page.evaluate(() => {
					(globalThis as any).releaseVaultArchive();
					return (globalThis as any).settleVaultArchive();
				});
				expect(
					await page.evaluate(() =>
						(globalThis as any).tryVaultArchiveDownload(),
					),
				).toEqual({ outputs: 0 });
			});
		}, 120_000);
	}

	test(`actual Web archive output error revokes its URL and finishes scope with ${withAttachment ? 1 : 0} Attachments`, async () => {
		await withVaultArchive(withAttachment, async ({ page, hide }) => {
			await page.evaluate(() => (globalThis as any).startVaultArchive());
			await page.evaluate(async () => {
				const click = HTMLAnchorElement.prototype.click;
				HTMLAnchorElement.prototype.click = () => {
					throw new Error("browser output failed");
				};
				try {
					await (globalThis as any).tryVaultArchiveDownload();
				} finally {
					HTMLAnchorElement.prototype.click = click;
				}
			});
			expect(
				await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
			).toMatchObject({
				ready: false,
				stage: "error",
				urlsCreated: 1,
				urlsRevoked: 1,
				liveUrls: 0,
			});
			hide();
			expect(
				await page.evaluate(() =>
					(globalThis as any).refreshVaultArchivePolicy(),
				),
			).toMatchObject({ result: { type: "succeeded" }, items: 0 });
			expect(
				await page.evaluate(() =>
					(globalThis as any).tryVaultArchiveDownload(),
				),
			).toEqual({ outputs: 0 });
		});
	}, 120_000);
}

test("actual Web archive hide drains downloaded plaintext before acknowledging capture cleanup", async () => {
	await withVaultArchive(true, async ({ page, hide }) => {
		await page.evaluate(() => {
			(globalThis as any).holdVaultArchive("attachmentWrite");
			(globalThis as any).queueVaultArchiveAction("start");
		});
		await page.waitForFunction(
			() => (globalThis as any).vaultArchiveLifetime().gateReached,
		);
		expect(
			(await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()))
				.provisionalAttachmentBytes,
		).toBeGreaterThan(0);
		hide();
		await page.evaluate(() =>
			(globalThis as any).queueVaultArchiveRetirement("hide"),
		);
		await page.waitForFunction(
			() => (globalThis as any).vaultArchiveLifetime().retirements === 1,
		);
		expect(
			await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
		).toMatchObject({
			ready: false,
			stage: "idle",
			activeTaskSettled: false,
			retirementSettled: false,
			cleanupAcknowledgements: 0,
			urlsCreated: 0,
		});
		await page.evaluate(() => {
			(globalThis as any).releaseVaultArchive();
			return (globalThis as any).settleVaultArchive();
		});
		const cleaned = await page.evaluate(() =>
			(globalThis as any).vaultArchiveLifetime(),
		);
		expect(cleaned).toMatchObject({
			ready: false,
			activeTaskSettled: true,
			retirementSettled: true,
			provisionalAttachmentBytes: 0,
			urlsCreated: 0,
		});
		expect(cleaned.attachmentDiscards).toBeGreaterThan(0);
	});
}, 120_000);

test("actual Web archive hide cancels a nonempty Attachment download before ZIP", async () => {
	await withVaultArchive(
		true,
		async ({ page, hide, holdDownload, releaseDownload, downloadReads }) => {
			holdDownload();
			await page.evaluate(() =>
				(globalThis as any).queueVaultArchiveAction("start"),
			);
			const deadline = Date.now() + 10_000;
			while (downloadReads() === 0 && Date.now() < deadline)
				await Bun.sleep(10);
			expect(downloadReads()).toBe(1);
			hide();
			await page.evaluate(() =>
				(globalThis as any).queueVaultArchiveRetirement("hide"),
			);
			await page.waitForFunction(
				() => (globalThis as any).vaultArchiveLifetime().retirements === 1,
			);
			releaseDownload();
			await page.evaluate(() => (globalThis as any).settleVaultArchive());
			expect(
				await page.evaluate(() => (globalThis as any).vaultArchiveLifetime()),
			).toMatchObject({
				ready: false,
				stage: "idle",
				urlsCreated: 0,
				activeTaskSettled: true,
				retirementSettled: true,
			});
			expect(
				await page.evaluate(() =>
					(globalThis as any).tryVaultArchiveDownload(),
				),
			).toEqual({ outputs: 0 });
		},
	);
}, 120_000);

test(
	"joined Worker thrown Export terminal callback does not acknowledge private cleanup",
	() => joinedExportRetirement("callbackThrow"),
	120_000,
);
