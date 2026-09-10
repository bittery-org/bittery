import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { WebStorageFamily } from "./web-storage-family";

const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);
let held: string[];
beforeEach(() => {
	held = [];
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: async (
					_name: string,
					options: LockOptions,
					callback: (lock: Lock | null) => Promise<void>,
				) => {
					const mode = options.mode ?? "exclusive";
					if (
						held.includes("exclusive") ||
						(mode === "exclusive" && held.length > 0)
					)
						return callback(null);
					held.push(mode);
					try {
						await callback({ mode } as Lock);
					} finally {
						held.splice(held.indexOf(mode), 1);
					}
				},
			},
		},
	});
});
afterEach(() => {
	if (originalNavigator)
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	else Reflect.deleteProperty(globalThis, "navigator");
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
test("normal shared lifetime covers all three version barriers and delayed store close", async () => {
	const closed = deferred();
	const family = new WebStorageFamily(() => closed.promise);
	await family.open();
	expect(held).toEqual(["shared"]);
	expect(
		(await indexedDB.databases()).map((x) => [x.name, x.version]).sort(),
	).toEqual(
		[
			["bittery-vault-image-artifacts", 2],
			["bittery_attachment_artifacts", 3],
			["bittery_replica", 8],
		].sort(),
	);
	const pending = family.close();
	await Promise.resolve();
	expect(held).toEqual(["shared"]);
	closed.resolve();
	await pending;
	expect(held).toEqual([]);
});
test("maintenance excludes peer owners and releases the retired owner on explicit exit", async () => {
	const a = new WebStorageFamily(async () => {});
	const b = new WebStorageFamily(async () => {});
	await a.open();
	await b.open();
	await expect(a.enterMaintenance()).rejects.toMatchObject({ reason: "busy" });
	await b.close();
	expect(await a.enterMaintenance()).toEqual({
		replicaVersion: 8,
		attachmentArtifactsVersion: 3,
		vaultImagesVersion: 2,
	});
	expect(held).toEqual(["exclusive"]);
	await expect(b.open()).rejects.toMatchObject({ reason: "busy" });
	await a.leaveMaintenance();
	await a.leaveMaintenance();
	expect(held).toEqual([]);
	await b.open();
	await a.close();
	await b.close();
	expect(held).toEqual([]);
});
test("partial family upgrade keeps earlier bytes but never grants maintenance", async () => {
	const request = indexedDB.open("bittery_attachment_artifacts", 99);
	const foreign = await new Promise<IDBDatabase>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	foreign.close();
	const family = new WebStorageFamily(async () => {});
	await expect(family.enterMaintenance()).rejects.toMatchObject({
		reason: "unsupported_version",
	});
	expect(held).toEqual([]);
	expect(
		(await indexedDB.databases()).find(
			(x) => x.name === "bittery_attachment_artifacts",
		)?.version,
	).toBe(99);
	expect(
		(await indexedDB.databases()).find((x) => x.name === "bittery_replica")
			?.version,
	).toBe(8);
});
test("close fences new executor calls and retains the lease until pending callbacks drain", async () => {
	const callback = deferred();
	const family = new WebStorageFamily(async () => {});
	await family.open();
	const work = family.runNormal(() => callback.promise);
	const close = family.close();
	await expect(family.runNormal(async () => {})).rejects.toMatchObject({
		reason: "busy",
	});
	await Promise.resolve();
	expect(held).toEqual(["shared"]);
	callback.resolve();
	await work;
	await close;
	expect(held).toEqual([]);
	await expect(family.runNormal(async () => {})).rejects.toMatchObject({
		reason: "busy",
	});
});
