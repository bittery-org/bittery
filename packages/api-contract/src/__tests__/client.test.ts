import { describe, expect, test } from "bun:test";
import { createApiClient } from "../client.ts";
import { ApiError } from "../errors.ts";
import type {
	ApiResult,
	LoginAttempt,
	SyncChanges,
	UpdateItemResponse,
} from "../index.ts";

function metadata() {
	return {
		serverRelease: "0.5.1",
		api: { supportedMajors: [1], preferredMajor: 1 },
		capabilities: ["attachments", "sync-sse"],
		limits: {
			itemCiphertextBytes: "1048576",
			bulkImportBytes: "16777216",
			bulkImportItems: 200,
		},
	};
}

describe("Bittery API facade", () => {
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

		const result: ApiResult<UpdateItemResponse> = await client.items.update(
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

	test("notifies the session owner when an authenticated request is rejected", async () => {
		let refreshRequired = 0;
		const client = createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => "access-token",
			getClientMetadata: () => ({
				id: "client-123",
				platform: "extension",
				version: "0.5.1",
			}),
			onSessionRefreshRequired: () => {
				refreshRequired += 1;
			},
			fetch: async () =>
				new Response(
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
				),
		});

		await expect(client.items.get("item-1")).rejects.toBeInstanceOf(ApiError);
		expect(refreshRequired).toBe(1);
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
});
