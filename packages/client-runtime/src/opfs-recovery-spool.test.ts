import { expect, test } from "bun:test";
import { RecoverySpool } from "./opfs-recovery-spool";
import { recoverySpoolDirectory as directory } from "./testing/recovery-spool";

test("recovery spool handles partial writes, flushes before preparation, and retains handed-off bytes until explicit release", async () => {
	const disk = directory();
	const spool = await RecoverySpool.create(disk.handle, "opaque-id");
	await spool.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
	const file = await spool.prepare();
	expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([
		1, 2, 3, 4, 5, 6, 7,
	]);
	expect(disk.closed()).toBe(1);
	await spool.discard();
	expect(disk.files.size).toBe(1);
	await expect(spool.write(new Uint8Array([8]))).rejects.toThrow();
	await RecoverySpool.release(disk.handle, "opaque-id");
	expect(disk.files.size).toBe(0);
});
test("quota failure retires and deletes only the incomplete encrypted spool", async () => {
	const disk = directory();
	disk.files.set("existing.btrrec", new Uint8Array([99]));
	const spool = await RecoverySpool.create(disk.handle, "failed-id");
	disk.fail();
	await expect(spool.write(new Uint8Array([1]))).rejects.toThrow();
	await expect(spool.prepare()).rejects.toThrow();
	await spool.discard();
	await spool.discard();
	expect(disk.files.get("existing.btrrec")).toEqual(new Uint8Array([99]));
	expect(disk.files.size).toBe(1);
	expect(disk.closed()).toBe(1);
});
test("absent synchronous handle refuses before writing and does not select a fallback", async () => {
	const disk = directory();
	const getFileHandle = disk.handle.getFileHandle.bind(disk.handle);
	const handle = {
		...disk.handle,
		async getFileHandle(name: string, options?: { create?: boolean }) {
			const file = await getFileHandle(name, options);
			return { getFile: file.getFile };
		},
	};
	await expect(RecoverySpool.create(handle, "unsupported")).rejects.toThrow();
	expect(disk.files.size).toBe(0);
});

test("oversized encrypted writes expose their typed bound and retire the incomplete spool", async () => {
	const disk = directory();
	const spool = await RecoverySpool.create(disk.handle, "bounded");
	await expect(spool.write(new Uint8Array(262145))).rejects.toMatchObject({
		code: "SIZE_REJECTED",
		recoveryBound: "chunkBytes",
	});
	expect(disk.files.size).toBe(0);
	await spool.discard();
});
