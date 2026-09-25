import { expect, test } from "bun:test";
import { createApiClient } from "@bittery/api-contract";
import type { ItemSyncCommand } from "@bittery/types";
import { CrossAccountItemCommandExecutor } from "./cross-account-item-command-executor";

// Rust profile admission consumes this fixture as the byte oracle for the legacy semantic
// workflow. Keep the producer on the actual TypeScript executor and API serializer.
const fixture = (await Bun.file(
	new URL(
		"./fixtures/legacy-cross-account-request-serialization.json",
		import.meta.url,
	),
).json()) as {
	command: ItemSyncCommand;
	captures: Array<{
		serverUrl: string;
		method: string;
		path: string;
		operationId: string;
		ifMatch: string | null;
		body: string;
	}>;
};

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function assertOriginalRequests(command: ItemSyncCommand): Promise<void> {
	const captures: typeof fixture.captures = [];
	const before = structuredClone(command);
	const sourceItemPath = "/api/v1/items/source%3Aitem%2F%E9%9B%AA";
	const targetItemPath = "/api/v1/items/target%3Aitem%2F%E9%9B%AA";
	const fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (
			request.method === "GET" &&
			url.origin === "https://target.legacy.invalid" &&
			url.pathname === targetItemPath
		) {
			return json(
				{
					type: "https://bittery.com/problems/not-found",
					title: "Not found",
					status: 404,
					code: "NOT_FOUND",
				},
				404,
			);
		}
		if (
			request.method === "GET" &&
			url.origin === "https://source.legacy.invalid" &&
			url.pathname === sourceItemPath
		) {
			return json({ version: command.baseVersion, deletedAt: null });
		}
		if (
			request.method === "GET" &&
			url.origin === "https://source.legacy.invalid" &&
			url.pathname === `${sourceItemPath}/attachments`
		) {
			return json({ items: [], hasMore: false, nextCursor: null });
		}
		if (request.method === "PUT" || request.method === "DELETE") {
			captures.push({
				serverUrl: url.origin,
				method: request.method,
				path: url.pathname,
				operationId: request.headers.get("Idempotency-Key") ?? "",
				ifMatch: request.headers.get("If-Match"),
				body: await request.text(),
			});
			const operationId = request.headers.get("Idempotency-Key") ?? "";
			const create = request.method === "PUT";
			const permanent = url.pathname.endsWith("/permanent");
			return json({
				operationId,
				kind: create
					? "create_item"
					: permanent
						? "permanently_delete_item"
						: "trash_item",
				result: {
					status: "applied",
					itemId: create ? command.targetItemId : command.entityId,
					version: create ? 1 : command.baseVersion + (permanent ? 2 : 1),
				},
			});
		}
		throw new Error(`Unexpected legacy Move request: ${request.method} ${url}`);
	};
	const client = (serverUrl: string) =>
		createApiClient({
			serverUrl,
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "legacy-cross-account-byte-conformance",
				platform: "desktop",
				version: "0.5.2",
			}),
			getAccessToken: () => "synthetic-token",
			fetch,
		});
	const sourceClient = client("https://source.legacy.invalid");
	const targetClient = client("https://target.legacy.invalid");
	const executor = new CrossAccountItemCommandExecutor({
		crypto: { destroyKey: async () => undefined } as never,
		vaultCrypto: { getVaultKey: async () => null } as never,
		getClientForAccount: async (accountId) => {
			if (accountId === command.accountId) return sourceClient;
			if (accountId === command.targetAccountId) return targetClient;
			throw new Error(`Unexpected Account scope: ${accountId}`);
		},
	});

	await expect(executor.executeSemanticItemCommand(command)).resolves.toEqual({
		entityId: command.entityId,
		etag: '"43"',
		version: 43,
	});
	expect(captures).toEqual(fixture.captures);
	expect(command).toEqual(before);
}

test("legacy cross-Account Move freezes all three actual request bytes and identities", async () => {
	await assertOriginalRequests(structuredClone(fixture.command));
});

test("legacy cross-Account history and reminted attempts leave all original child requests unchanged", async () => {
	for (const status of [
		undefined,
		"staged",
		"applying",
		"pending",
		"retrying",
	] as const) {
		const command: ItemSyncCommand = {
			...structuredClone(fixture.command),
			attemptId: "reminted-attachment-attempt-after-client-acquisition-failure",
			retryCount: 3,
			lastError: "source client temporarily unavailable",
			nextAttemptAt: 1_800_000_000_000,
			projectionClaimId: "departed-projector",
			projectionClaimExpiresAt: 1_800_000_000_500,
		};
		if (status === undefined) delete command.status;
		else command.status = status;
		await assertOriginalRequests(command);
	}
});
