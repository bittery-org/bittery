import { expect, test } from "bun:test";
import { RecoveryLimitError } from "./recovery-limit";
import { WebRecoveryExecutor } from "./web-recovery-executor";
import type { WebStorageFamily } from "./web-storage-family";

function fixture() {
	let maintenance = false;
	let releases = 0;
	const family = {
		async enterMaintenance() {
			maintenance = true;
			return {
				replicaVersion: 81,
				attachmentArtifactsVersion: 31,
				vaultImagesVersion: 21,
			};
		},
		async leaveMaintenance() {
			maintenance = false;
			releases++;
		},
		async open() {},
		runMaintenance<T>(action: () => Promise<T>) {
			if (!maintenance) throw new Error("not held");
			return action();
		},
	} as unknown as WebStorageFamily;
	let finish!: (reply: {
		control: { type: "sourceChunk"; eof: boolean };
		binaryChunk: Uint8Array;
	}) => void;
	const executor = new WebRecoveryExecutor(
		family,
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const call = async (value: object) =>
		JSON.parse(
			(await executor.invoke(JSON.stringify(value))).controlResponseJson,
		);
	return { executor, call, finish: () => finish, releases: () => releases };
}
test("cancel retires a held source read, wipes its late bytes, and permits only cleanup", async () => {
	const f = fixture();
	expect(await f.call({ type: "enterMaintenance", recoveryId: "r" })).toEqual({
		type: "maintenanceEntered",
		physicalSchemas: {
			replicaVersion: 81,
			attachmentArtifactsVersion: 31,
			vaultImagesVersion: 21,
		},
	});
	const pending = f.call({
		type: "sourceRead",
		recoveryId: "r",
		accountId: "a",
		capabilityId: "c",
		maxBytes: 10,
	});
	await Promise.resolve();
	f.executor.cancel("r");
	expect(await pending).toEqual({ type: "unavailable", reason: "cancelled" });
	expect(
		await f.call({ type: "readEntry", recoveryId: "r", accountId: "a" }),
	).toEqual({ type: "unavailable", reason: "cancelled" });
	const bytes = new Uint8Array([1, 2, 3]);
	f.finish()({
		control: { type: "sourceChunk", eof: false },
		binaryChunk: bytes,
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(bytes).toEqual(new Uint8Array(3));
	expect(await f.call({ type: "leaveMaintenance", recoveryId: "r" })).toEqual({
		type: "maintenanceLeft",
	});
	expect(await f.call({ type: "leaveMaintenance", recoveryId: "r" })).toEqual({
		type: "maintenanceLeft",
	});
	expect(f.releases()).toBe(1);
});
test("a foreign cleanup cannot release another recovery lease", async () => {
	const f = fixture();
	await f.call({ type: "enterMaintenance", recoveryId: "r" });
	expect(
		await f.call({ type: "leaveMaintenance", recoveryId: "other" }),
	).toEqual({ type: "unavailable", reason: "corrupt" });
	expect(f.releases()).toBe(0);
	await f.call({ type: "leaveMaintenance", recoveryId: "r" });
});
test("failed entry acknowledgement still requires scoped idempotent lease cleanup", async () => {
	let held = false;
	const family = {
		async enterMaintenance() {
			held = true;
			throw new Error("lost entry acknowledgement");
		},
		async leaveMaintenance() {
			held = false;
		},
		runMaintenance<T>(action: () => Promise<T>) {
			return action();
		},
	} as unknown as WebStorageFamily;
	const executor = new WebRecoveryExecutor(family, async () => ({
		control: { type: "sourceEnded" },
	}));
	const call = async (value: object) =>
		JSON.parse(
			(await executor.invoke(JSON.stringify(value))).controlResponseJson,
		);
	expect(await call({ type: "enterMaintenance", recoveryId: "r" })).toEqual({
		type: "unavailable",
		reason: "corrupt",
	});
	expect(held).toBe(true);
	expect(
		await call({ type: "leaveMaintenance", recoveryId: "foreign" }),
	).toEqual({ type: "unavailable", reason: "corrupt" });
	expect(held).toBe(true);
	expect(await call({ type: "leaveMaintenance", recoveryId: "r" })).toEqual({
		type: "maintenanceLeft",
	});
	expect(held).toBe(false);
	expect(await call({ type: "leaveMaintenance", recoveryId: "r" })).toEqual({
		type: "maintenanceLeft",
	});
});

test("a physical byte guard returns a terminal typed limit instead of corrupt-prefix evidence", async () => {
	const family = {
		enterMaintenance: async () => ({
			replicaVersion: 8,
			attachmentArtifactsVersion: 3,
			vaultImagesVersion: 2,
		}),
		leaveMaintenance: async () => {},
		runMaintenance: async <T>(action: () => Promise<T>) => action(),
	} as unknown as WebStorageFamily;
	const executor = new WebRecoveryExecutor(family, async () => {
		throw new RecoveryLimitError("archiveBytes");
	});
	await executor.invoke('{"type":"enterMaintenance","recoveryId":"r"}');
	const reply = await executor.invoke(
		'{"type":"sourceRead","recoveryId":"r","accountId":"a","capabilityId":"c","maxBytes":10}',
	);
	expect(JSON.parse(reply.controlResponseJson)).toEqual({
		type: "limitExceeded",
		bound: "archiveBytes",
	});
	await executor.invoke('{"type":"leaveMaintenance","recoveryId":"r"}');
});
