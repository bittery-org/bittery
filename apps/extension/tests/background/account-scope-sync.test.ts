import { expect, mock, test } from "bun:test";

const calls: string[] = [];

mock.module("../../src/background/sync-manager", () => ({
	cleanupSync: async () => calls.push("cleanup"),
	connect: async () => calls.push("connect"),
	disconnect: (reason: string) => calls.push(`disconnect:${reason}`),
	getClientId: async () => "client",
	getStatus: () => "disconnected",
	initializeSync: async () => calls.push("initialize"),
}));

const { reconcileSyncAccountScope } = await import(
	"../../src/background/router/sync-effects"
);

test("account-scope reconciliation replaces the stream without logout cleanup", async () => {
	await reconcileSyncAccountScope();

	expect(calls).toEqual(["disconnect:account scope changed", "initialize"]);
});
