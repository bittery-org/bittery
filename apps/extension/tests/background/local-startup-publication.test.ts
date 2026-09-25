import { expect, mock, test } from "bun:test";
import path from "node:path";

const background = path.resolve(import.meta.dir, "../../src/background");
const events: string[] = [];
let stalePublication: Awaited<
	ReturnType<
		typeof import("../../src/background/local-material-publication")["localMaterialPublication"]["capture"]
	>
>;
mock.module(path.resolve(background, "../lib/crypto.ts"), () => ({
	crypto: { initialize: async () => {} },
}));
mock.module(path.resolve(background, "../lib/storage.ts"), () => ({
	initializeStorage: async () => {},
	storage: {},
	itemCache: {},
}));
mock.module(path.join(background, "vault-session.ts"), () => ({
	vaultSession: {
		dispatch: async (event: { type: string }) => {
			events.push(event.type);
		},
	},
}));
mock.module(path.join(background, "session-manager.ts"), () => ({
	handleAutoLockAlarm: async () => {},
	refreshAutoLockTimeout: async () => {},
}));
mock.module(path.join(background, "outbound-drain.ts"), () => ({
	handleOutboundRetryAlarm: async () => {},
}));
mock.module(path.join(background, "sync-manager.ts"), () => ({
	handleSyncReconnectAlarm: async () => {},
}));
mock.module(path.join(background, "services/session-restore.ts"), () => ({
	restoreUnlockedSessions: async () => ({
		accountIds: ["account-a"],
		muk: new Uint8Array([3]),
		publication: stalePublication,
	}),
}));
const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
const { localMaterialPublication } = await import(
	path.join(background, "local-material-publication.ts")
);
const { initializeBackgroundServices } = await import(
	path.join(background, "services/service-worker-lifecycle.ts")
);

test("startup refuses stale restored UI state and waits for C1 acknowledgement", async () => {
	stalePublication = await localMaterialPublication.capture();
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => (entered = resolve));
	const held = new Promise<void>((resolve) => (release = resolve));
	nativeMessagingClient.configureRetirementCleanup(async () => {
		entered();
		await held;
	});
	const retirement = nativeMessagingClient.retireObservedStatus({
		locked: true,
		timestamp: 1,
	});
	await started;
	let ready = false;
	const startup = initializeBackgroundServices({
		start: () => {},
	} as never).then(() => {
		ready = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(ready).toBe(false);
	expect(events).not.toContain("STARTUP_RESTORED");
	release();
	await retirement;
	await startup;
	expect(ready).toBe(true);
	expect(events).not.toContain("LOCAL_UNLOCKED");
	expect(events).not.toContain("STARTUP_RESTORED");
});
