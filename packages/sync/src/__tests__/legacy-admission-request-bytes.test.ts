import { expect, test } from "bun:test";
import { createApiClient } from "@bittery/api-contract";
import type { ItemSyncCommand } from "@bittery/types";
import { ItemSyncEngine } from "../outbound-queue";
import type { SyncStorage } from "../types";

// These byte vectors are also the compatibility oracle for Rust profile admission. Drive the
// production queue and API serializer so a legacy change cannot silently invalidate that oracle.
const vectors = (await Bun.file(
	new URL(
		"../../../../planning/evolutionary-rust-runtime/desktop-extension/fixtures/legacy-request-serialization.json",
		import.meta.url,
	),
).json()) as {
	captures: {
		name: string;
		method: string;
		path: string;
		operationId: string;
		ifMatch: string | null;
		body: string;
	}[];
	sourceCommands: Record<string, ItemSyncCommand>;
};

class QueueStorage implements SyncStorage {
	private readonly values = new Map<string, unknown>();
	async get<T>(key: string): Promise<T | null> {
		return structuredClone((this.values.get(key) as T | undefined) ?? null);
	}
	async set<T>(key: string, value: T): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
	async remove(key: string): Promise<void> {
		this.values.delete(key);
	}
	async update<T>(
		key: string,
		updater: (value: T | null) => T | null,
	): Promise<T | null> {
		// The fixture invokes one queue at a time. Keep update synchronous until the map write.
		const next = updater(
			structuredClone((this.values.get(key) as T | undefined) ?? null),
		);
		if (next === null) this.values.delete(key);
		else this.values.set(key, structuredClone(next));
		return structuredClone(next);
	}
}

expect(vectors.captures).toHaveLength(12);

for (const expected of vectors.captures) {
	const { name } = expected;
	test(`legacy admission freezes actual request bytes: ${name}`, async () => {
		const storage = new QueueStorage();
		const queue = new ItemSyncEngine(
			storage,
			"legacy-byte-conformance",
			undefined,
			() => 1,
		);
		const command = structuredClone(vectors.sourceCommands[name]);
		if (!command) throw new Error(`Missing source command: ${name}`);
		// The fixture deliberately reverses ciphertext field insertion order and includes
		// envelope metadata absent from HTTP. Rust consumes this exact source command too.
		const captured: typeof vectors.captures = [];
		const client = createApiClient({
			serverUrl: "https://legacy-byte-conformance.invalid",
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "legacy-byte-conformance",
				platform: "desktop",
				version: "0.5.2",
			}),
			getAccessToken: () => "synthetic-token",
			fetch: async (request) => {
				captured.push({
					name,
					method: request.method,
					path: new URL(request.url).pathname,
					operationId: request.headers.get("Idempotency-Key") ?? "",
					ifMatch: request.headers.get("If-Match"),
					body: await request.text(),
				});
				throw new TypeError("synthetic offline capture; no request is sent");
			},
		});
		await queue.enqueue(command);
		await queue.drain(() => client);
		expect(captured).toEqual([expected]);
		// Failed delivery keeps the original semantic and attempt identities in durable storage.
		const persisted = await storage.get<Record<string, ItemSyncCommand[]>>(
			"bittery_pending_mutation_queues_v3",
		);
		expect(persisted?.[command.accountId]?.[0]?.operationId).toBe(
			command.operationId ?? command.id,
		);
		expect(persisted?.[command.accountId]?.[0]?.attemptId).toBe(
			command.attemptId ?? command.id,
		);
	});
}
