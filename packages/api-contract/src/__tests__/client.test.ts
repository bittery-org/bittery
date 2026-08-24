import { describe, expect, test } from "bun:test";
import { createApiClient } from "../client.ts";
import { ApiError } from "../errors.ts";
import type {
	ApiResult,
	LoginAttempt,
	OperationOutcome,
	SyncChanges,
} from "../index.ts";

function metadata() {
	return {
		serverRelease: "0.5.1",
		api: { supportedMajors: [1], preferredMajor: 1 },
		capabilities: ["attachments", "sync-sse"],
		limits: {
			itemCiphertextBytes: "1048576",
			encryptedVaultKeyBytes: "65536",
			bulkImportBytes: "16777216",
			bulkImportItems: 200,
		},
	};
}

describe("Bittery API facade", () => {
	test("drains issued vault-key pages with a request-scoped bearer token", async () => {
		const requests: Request[] = [];
		let providerCalls = 0;
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => {
				providerCalls += 1;
				return null;
			},
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				return new Response(
					JSON.stringify({
						items: [
							{
								vaultId: "vault-2",
								vaultName: "Second",
								vaultType: "personal",
								encryptedVaultKey: "wrapped-2",
								role: "owner",
							},
						],
						nextCursor: null,
						hasMore: false,
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			},
		});

		const result = await client.auth.drainVaultKeys(
			"just-issued",
			{
				items: [
					{
						vaultId: "vault-1",
						vaultName: "First",
						vaultType: "personal",
						encryptedVaultKey: "wrapped-1",
						role: "owner",
					},
				],
				nextCursor: "page-2",
				hasMore: true,
			},
			{
				kind: "authCeremony",
				serverUrl: "https://api.example.test",
				insecureTransportConfirmed: false,
			},
		);

		expect(result.data.map((key) => key.vaultId)).toEqual([
			"vault-1",
			"vault-2",
		]);
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer just-issued",
		);
		expect(requests[0]?.headers.get("Bittery-Local-Request-Origin")).toBeNull();
		expect(providerCalls).toBe(1);
	});

	test("rejects remote HTTP unless both insecure transport approvals are explicit", () => {
		const options = {
			serverUrl: "http://192.0.2.10:3000",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "desktop" as const,
				version: "0.5.1",
			}),
		};

		expect(() => createApiClient(options)).toThrow(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
		expect(() =>
			createApiClient({
				...options,
				insecureTransport: {
					operatorEnabled: true,
					accountConfirmed: false,
				},
			}),
		).toThrow(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
		expect(() =>
			createApiClient({
				...options,
				insecureTransport: {
					operatorEnabled: true,
					accountConfirmed: true,
				},
			}),
		).not.toThrow();
		expect(() =>
			createApiClient({ ...options, serverUrl: "http://127.0.0.1:3000" }),
		).not.toThrow();
	});

	test("adds auth and Bittery metadata through transport middleware", async () => {
		const requests: Request[] = [];
		const sessionExpires: string[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test/",
			supportedApiMajors: [1],
			getAccessToken: async () => "session-token",
			getClientMetadata: () => ({
				id: "client-123",
				platform: "extension",
				version: "0.5.1",
			}),
			onSessionExpires: (expiresAt) => {
				sessionExpires.push(expiresAt);
			},
			fetch: async (request) => {
				requests.push(request);
				return new Response(JSON.stringify(metadata()), {
					headers: { "Bittery-Session-Expires": "2026-01-01T00:00:00Z" },
				});
			},
		});

		const negotiation = await client.meta.negotiate();
		const request = requests[0];

		expect(negotiation.major).toBe(1);
		expect(request?.url).toBe("https://api.example.test/api/meta");
		expect(request?.headers.get("Authorization")).toBe("Bearer session-token");
		expect(request?.headers.get("Bittery-Client-Id")).toBe("client-123");
		expect(request?.headers.get("Bittery-Client-Platform")).toBe("extension");
		expect(request?.headers.get("Bittery-Client-Version")).toBe("0.5.1");
		expect(sessionExpires).toEqual(["2026-01-01T00:00:00Z"]);
	});

	test("surfaces problem details instead of openapi-fetch error payloads", async () => {
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => "access-token",
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async () =>
				new Response(
					JSON.stringify({
						type: "https://bittery.com/problems/authentication-required",
						title: "Authentication required",
						status: 401,
						code: "AUTHENTICATION_REQUIRED",
						retryable: false,
					}),
					{ status: 401 },
				),
		});

		try {
			await client.meta.get();
			expect.unreachable("metadata request should fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).code).toBe("AUTHENTICATION_REQUIRED");
		}
	});

	test("keeps auth inputs and 201 responses inside the facade", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				return new Response(
					JSON.stringify({
						attemptId: "attempt-1",
						salt: "salt",
						serverPublicKey: "server-key",
						kdfParams: {},
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			},
		});

		const result: ApiResult<LoginAttempt> = await client.auth.startLogin({
			email: "person@example.test",
			clientPublicKey: "client-key",
		});

		expect(result.data.attemptId).toBe("attempt-1");
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe(
			"https://api.example.test/api/v1/auth/login-attempts",
		);
		expect(await requests[0]?.json()).toEqual({
			email: "person@example.test",
			clientPublicKey: "client-key",
		});
	});

	test("sends conditional write headers and returns ETag metadata", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => "access-token",
			getClientMetadata: () => ({
				id: "client-123",
				platform: "desktop",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				return new Response(JSON.stringify({}), {
					headers: {
						"Content-Type": "application/json",
						ETag: '"version-7"',
						"Bittery-Request-Id": "request-1",
					},
				});
			},
		});

		const result: ApiResult<OperationOutcome> = await client.items.update(
			"item-1",
			{ encryptedData: null },
			{ etag: '"version-6"', idempotencyKey: "request-key-1" },
		);
		const request = requests[0];

		expect(result.etag).toBe('"version-7"');
		expect(result.requestId).toBe("request-1");
		expect(request?.method).toBe("PATCH");
		expect(request?.headers.get("If-Match")).toBe('"version-6"');
		expect(request?.headers.get("Idempotency-Key")).toBe("request-key-1");
		expect(request?.headers.get("Authorization")).toBe("Bearer access-token");
		expect(request?.headers.get("Content-Type")).toBe(
			"application/merge-patch+json",
		);
	});

	test("fetches an authenticated retained Operation outcome through the facade", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => "access-token",
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				return Response.json({
					operationId: "operation-1",
					kind: "create_item",
					result: {
						status: "rejected",
						code: "vault_read_only",
					},
				});
			},
		});

		const outcome = await client.operations.get("operation-1");

		expect(outcome.data.result).toEqual({
			status: "rejected",
			code: "vault_read_only",
		});
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.url).toBe(
			"https://api.example.test/api/v1/operations/operation-1",
		);
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer access-token",
		);
	});

	test("validates sync response shape and converts decimal event timestamps", async () => {
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "mobile",
				version: "0.5.1",
			}),
			fetch: async () =>
				new Response(
					JSON.stringify({
						events: [
							{
								id: "event-1",
								type: "item.updated",
								entityId: "item-1",
								entityType: "item",
								version: 2,
								userId: "user-1",
								timestamp: "1710000000000",
								metadata: {},
							},
						],
						hasMore: false,
						requiresFullRefresh: false,
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		});

		const result: ApiResult<SyncChanges> = await client.sync.changes({
			vaultIds: ["vault-1"],
			limit: 100,
		});

		expect(result.data.events[0]?.timestamp).toBe(1_710_000_000_000n);
	});

	test("pins and validates a bootstrap sync watermark", async () => {
		const requests: Request[] = [];
		let malformed = false;
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				const phase = new URL(request.url).searchParams.get("phase");
				return Response.json({
					phase,
					...(phase === "vaults" ? { vaults: [] } : { items: [] }),
					hasMore: false,
					syncCursor: malformed ? { id: 42 } : null,
				});
			},
		});

		const result = await client.sync.bootstrap({
			phase: "items",
			cursor: "page-2",
			syncCursor: "evt-bootstrap",
			syncCursorCaptured: true,
		});
		expect(result.data.syncCursor).toBeNull();
		expect(new URL(requests[0]?.url ?? "").searchParams).toEqual(
			new URLSearchParams({
				phase: "items",
				cursor: "page-2",
				syncCursor: "evt-bootstrap",
				syncCursorCaptured: "true",
			}),
		);
		const vaultResult = await client.sync.bootstrap({
			phase: "vaults",
			syncCursorCaptured: true,
		});
		expect(vaultResult.data.phase).toBe("vaults");
		if (vaultResult.data.phase === "vaults") {
			expect(vaultResult.data.vaults).toEqual([]);
		}

		malformed = true;
		await expect(client.sync.bootstrap({ phase: "items" })).rejects.toThrow(
			"/sync/bootstrap/syncCursor/id must be a non-empty string",
		);
	});

	test("refreshes and replays an authenticated request exactly once after a 401", async () => {
		let refreshRequired = 0;
		let accessToken = "expired-token";
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => accessToken,
			getClientMetadata: () => ({
				id: "client-123",
				platform: "extension",
				version: "0.5.1",
			}),
			onSessionRefreshRequired: () => {
				refreshRequired += 1;
				accessToken = "refreshed-token";
			},
			fetch: async (request) => {
				requests.push(request);
				if (request.headers.get("Authorization") === "Bearer refreshed-token") {
					return Response.json({});
				}
				return new Response(
					JSON.stringify({
						type: "https://bittery.com/problems/authentication-required",
						title: "Authentication required",
						status: 401,
						code: "AUTHENTICATION_REQUIRED",
					}),
					{
						status: 401,
						headers: { "Content-Type": "application/problem+json" },
					},
				);
			},
		});

		await client.items.get("item-1");
		expect(refreshRequired).toBe(1);
		expect(requests).toHaveLength(2);
		expect(
			requests.map((request) => request.headers.get("Authorization")),
		).toEqual(["Bearer expired-token", "Bearer refreshed-token"]);
	});

	test("keeps one-time share secrets and final domain operations inside the facade", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				if (request.url.endsWith("/share-links")) {
					return new Response(
						JSON.stringify({
							id: "share-1",
							token: "one-time-token",
							baseShareUrl: "https://share.example.test",
							expiresAt: "2026-01-01T00:00:00Z",
						}),
						{ status: 201, headers: { "Content-Type": "application/json" } },
					);
				}

				if (request.url.endsWith("/travel-mode")) {
					return new Response(
						JSON.stringify({
							enabled: false,
							hiddenVaultIds: [],
							updatedAt: "2026-01-01T00:00:00Z",
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({ events: [], nextCursor: null }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});

		const share = await client.share.create("item-1", {
			accessMode: "anyone",
			encryptedItemData: "ciphertext",
			encryptedShareKey: "share-key",
			encryptionIv: "iv",
			expiresIn: "1day",
			shareKeyIv: "share-iv",
		});
		const travelMode = await client.travelMode.get();
		const audit = await client.audit.list({ actionGroup: "share", limit: 10 });

		expect(share.data.token).toBe("one-time-token");
		expect(requests).toHaveLength(3);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe(
			"https://api.example.test/api/v1/items/item-1/share-links",
		);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBeNull();
		expect(travelMode.data.enabled).toBe(false);
		expect(audit.data.events).toEqual([]);
		expect(requests[2]?.url).toBe(
			"https://api.example.test/api/v1/audit-events?actionGroup=share&limit=10",
		);
	});

	test("never exposes idempotency headers on one-time invitation secrets", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				return Response.json(
					request.url.endsWith("/resend")
						? { invitationId: "invitation-1", token: "resend-token" }
						: {
								invitationId: "invitation-1",
								token: "send-token",
								existingUserPublicKey: null,
							},
				);
			},
		});

		const sent = await client.teams.invitations.send("team-1", {
			email: "invitee@example.test",
			role: "member",
			pendingVaultKeys: null,
		});
		const resent = await client.teams.invitations.resend(
			"team-1",
			"invitation-1",
		);

		expect(sent.data.token).toBe("send-token");
		expect(resent.data.token).toBe("resend-token");
		expect(
			requests.map((request) => request.headers.get("Idempotency-Key")),
		).toEqual([null, null]);
	});

	test("converts billing decimal strings before exposing entitlement limits", async () => {
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "desktop",
				version: "0.5.1",
			}),
			fetch: async (request) =>
				new Response(
					JSON.stringify(
						request.url.endsWith("/entitlements")
							? {
									billingEnabled: true,
									entitlements: {
										attachments: true,
										billingPortal: true,
										sentinel: false,
										shareLinks: true,
										teamManagement: false,
										vaultSharing: true,
									},
									isActive: true,
									limits: {
										attachmentMaxFileSizeBytes: "1048576",
										attachmentStorageBytes: "9007199254740993",
										shareLinks: null,
										sharedVaults: "5",
									},
									mode: "cloud",
									plan: "personal",
									status: "active",
								}
							: {
									attachmentsEnabled: true,
									committedStorageBytes: "9007199254740993",
									mode: "cloud",
									quotaBytes: "10000000000000000",
								},
					),
					{ headers: { "Content-Type": "application/json" } },
				),
		});

		const [entitlements, usage] = await Promise.all([
			client.billing.entitlements(),
			client.billing.attachmentUsage(),
		]);

		expect(entitlements.data.limits.attachmentStorageBytes).toBe(
			9_007_199_254_740_993n,
		);
		expect(entitlements.data.limits.shareLinks).toBeNull();
		expect(usage.data.committedStorageBytes).toBe(9_007_199_254_740_993n);
		expect(usage.data.quotaBytes).toBe(10_000_000_000_000_000n);
	});

	test("drains cursor pages for exhaustive collection methods", async () => {
		const requests: Request[] = [];
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => {
				requests.push(request);
				const cursor = new URL(request.url).searchParams.get("cursor");
				return Response.json(
					cursor
						? {
								items: [{ id: "item-2", attachments: [] }],
								hasMore: false,
							}
						: {
								items: [{ id: "item-1", attachments: [] }],
								hasMore: true,
								nextCursor: "cursor-2",
							},
				);
			},
		});

		const result = await client.items.list();

		expect(result.data.map((item) => item.id)).toEqual(["item-1", "item-2"]);
		expect(result.data.every((item) => Array.isArray(item.attachments))).toBe(
			true,
		);
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.example.test/api/v1/items",
			"https://api.example.test/api/v1/items?cursor=cursor-2",
		]);
	});

	test("requires active attachment arrays while allowing trashed items to omit them", async () => {
		let includeActiveAttachments = true;
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) =>
				Response.json({
					items: [
						request.url.endsWith("/trashed")
							? { id: "trashed-item" }
							: {
									id: "active-item",
									...(includeActiveAttachments ? { attachments: [] } : {}),
								},
					],
					hasMore: false,
				}),
		});

		const active = await client.items.list();
		const trashed = await client.items.listTrashed();
		expect(active.data[0]?.attachments).toEqual([]);
		expect("attachments" in (trashed.data[0] ?? {})).toBe(false);

		includeActiveAttachments = false;
		expect(client.items.list()).rejects.toThrow(
			"attachments must be an array for an active item",
		);
	});

	test("rejects malformed collection continuation metadata", async () => {
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "client-123",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async () => Response.json({ items: [], hasMore: true }),
		});

		expect(client.vaults.list()).rejects.toThrow(
			"/api/v1/vaults returned hasMore without a nextCursor.",
		);
	});
});
