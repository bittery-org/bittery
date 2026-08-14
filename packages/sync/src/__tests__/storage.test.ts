import { describe, expect, test } from "bun:test";
import { MemorySyncStorage, NamespacedSyncStorage } from "../storage";
import type { SyncStorage } from "../types";

function runSyncStorageConformance(
	name: string,
	createStorage: () => SyncStorage,
): void {
	describe(`${name} SyncStorage conformance`, () => {
		test("serializes overlapping document mutations", async () => {
			const storage = createStorage();

			await Promise.all(
				Array.from({ length: 50 }, () =>
					storage.update<number>("document", (current) => (current ?? 0) + 1),
				),
			);

			expect(await storage.get<number>("document")).toBe(50);
		});

		test("removes a document when its mutation returns null", async () => {
			const storage = createStorage();
			await storage.set("document", { pending: 1 });

			const result = await storage.update("document", () => null);

			expect(result).toBeNull();
			expect(await storage.get("document")).toBeNull();
		});
	});
}

runSyncStorageConformance("memory", () => new MemorySyncStorage());
runSyncStorageConformance(
	"namespaced memory",
	() => new NamespacedSyncStorage(new MemorySyncStorage(), "account:a"),
);

test("namespaces atomic mutations in the backing store", async () => {
	const backing = new MemorySyncStorage();
	const storage = new NamespacedSyncStorage(backing, "source:a");

	await storage.update("cursor", () => ({ id: "event_1" }));

	expect(await backing.get<{ id: string }>("source:a:cursor")).toEqual({
		id: "event_1",
	});
	expect(await backing.get("cursor")).toBeNull();
});
