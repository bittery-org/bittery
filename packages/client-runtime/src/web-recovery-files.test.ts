import { expect, test } from "bun:test";
import type { RecoveryControlRequest } from "../generated/recovery-control/contract";
import { RecoverySpool } from "./opfs-recovery-spool";
import { recoverySpoolDirectory } from "./testing/recovery-spool";
import {
	RecoveryFileRegistry,
	RecoveryWorkerFiles,
} from "./web-recovery-files";
import { acquireStorageFamilyLease } from "./web-storage-maintenance";

function request(
	registry: RecoveryFileRegistry,
	request: RecoveryControlRequest,
	incarnation = "owner",
) {
	return registry.invoke({
		type: "recoveryTransfer",
		runtimeIncarnation: incarnation,
		controlRequestJson: JSON.stringify(request),
	});
}
test("one immutable recovery File supplies bounded reads, exact EOF, and same-source rewind", async () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	const capabilityId = registry.grantSource(
		"a",
		new File([new Uint8Array([0, 255, 8, 9])], "recovery.btrrec"),
	);
	const base = { accountId: "a", recoveryId: "recovery", capabilityId };
	expect(
		(await request(registry, { ...base, type: "sourceRead", maxBytes: 3 }))
			.binaryChunk,
	).toEqual(new Uint8Array([0, 255, 8]));
	expect(
		(await request(registry, { ...base, type: "sourceRead", maxBytes: 3 }))
			.binaryChunk,
	).toEqual(new Uint8Array([9]));
	expect(
		(await request(registry, { ...base, type: "sourceRead", maxBytes: 3 }))
			.control.type,
	).toBe("sourceEnded");
	expect(
		(await request(registry, { ...base, type: "sourceRewind" })).control.type,
	).toBe("sourceRewound");
	expect(
		(await request(registry, { ...base, type: "sourceRead", maxBytes: 4 }))
			.binaryChunk,
	).toEqual(new Uint8Array([0, 255, 8, 9]));
	await request(registry, { ...base, type: "sourceClose" });
	await expect(
		request(registry, { ...base, type: "sourceRewind" }),
	).rejects.toThrow();
});
test("recovery File grants reject other Accounts, purposes, recovery scopes and retired incarnations", async () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	const capabilityId = registry.grantSource(
		"a",
		new File(["encrypted"], "recovery.btrrec"),
	);
	const base = { accountId: "a", recoveryId: "r", capabilityId };
	await expect(
		request(registry, {
			...base,
			accountId: "b",
			type: "sourceRead",
			maxBytes: 1,
		}),
	).rejects.toThrow();
	await expect(
		request(registry, { ...base, type: "sinkWrite" }),
	).rejects.toThrow();
	await request(registry, { ...base, type: "sourceRead", maxBytes: 1 });
	await expect(
		request(registry, {
			...base,
			recoveryId: "other",
			type: "sourceRead",
			maxBytes: 1,
		}),
	).rejects.toThrow();
	registry.prepare("replacement");
	await expect(
		request(registry, { ...base, type: "sourceRead", maxBytes: 1 }),
	).rejects.toThrow();
});

test("a cancelled held File read settles before platform completion and wipes the late bytes", async () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	let release!: (bytes: ArrayBuffer) => void;
	const gate = new Promise<ArrayBuffer>((resolve) => {
		release = resolve;
	});
	const file = new File(["encrypted"], "recovery.btrrec");
	Object.defineProperty(file, "slice", {
		value: () => ({ arrayBuffer: () => gate }),
	});
	const capabilityId = registry.grantSource("a", file);
	const base = { accountId: "a", recoveryId: "r", capabilityId };
	const pending = request(registry, {
		...base,
		type: "sourceRead",
		maxBytes: 4,
	});
	registry.cancel({
		type: "recoveryCancel",
		runtimeIncarnation: "foreign",
		recoveryId: "r",
	});
	registry.cancel({
		type: "recoveryCancel",
		runtimeIncarnation: "owner",
		recoveryId: "r",
	});
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	await request(registry, { ...base, type: "sourceClose" });
	const bytes = new Uint8Array([1, 2, 3, 4]);
	release(bytes.buffer);
	await Promise.resolve();
	await Promise.resolve();
	expect(bytes).toEqual(new Uint8Array(4));
});

test("early refused grants retire their File and do not exhaust later attempts", async () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	for (let i = 0; i < 140; i++) {
		const id = registry.grantSource("a", new File(["ciphertext"], "file"));
		registry.discardGrant(id);
		await expect(
			request(registry, {
				type: "sourceRead",
				accountId: "a",
				recoveryId: "r",
				capabilityId: id,
				maxBytes: 1,
			}),
		).rejects.toThrow();
	}
	expect(registry.grantSink("a")).toBeString();
});

test("the existing Worker file bridge cancels its main-thread read and admits cleanup", async () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	let release!: (buffer: ArrayBuffer) => void;
	const held = new Promise<ArrayBuffer>((resolve) => {
		release = resolve;
	});
	const file = new File(["encrypted"], "archive");
	Object.defineProperty(file, "slice", {
		value: () => ({ arrayBuffer: () => held }),
	});
	const capabilityId = registry.grantSource("a", file);
	const commands: string[] = [];
	const worker = new RecoveryWorkerFiles("owner", async (message) => {
		commands.push(message.type);
		if (message.type === "recoveryCancel") {
			registry.cancel(message);
			return undefined;
		}
		return registry.invoke(message);
	});
	const controller = new AbortController();
	const base = { accountId: "a", recoveryId: "r", capabilityId };
	const pending = worker.invoke(
		{ ...base, type: "sourceRead", maxBytes: 4 },
		undefined,
		controller.signal,
	);
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(commands).toEqual(["recoveryTransfer", "recoveryCancel"]);
	expect(
		(await worker.invoke({ ...base, type: "sourceClose" })).control.type,
	).toBe("sourceClosed");
	const bytes = new Uint8Array([9, 8, 7, 6]);
	release(bytes.buffer);
	await Promise.resolve();
	await Promise.resolve();
	expect(bytes).toEqual(new Uint8Array(4));
	await worker.close();
});

function withSpoolDirectory() {
	const disk = recoverySpoolDirectory();
	const held: string[] = [];
	const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: async (
					name: string,
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
						await callback({ name, mode } as Lock);
					} finally {
						held.splice(held.indexOf(mode), 1);
					}
				},
			},
			storage: {
				getDirectory: async () => ({
					getDirectoryHandle: async () => disk.handle,
				}),
			},
		},
	});
	return {
		disk,
		restore() {
			if (original) Object.defineProperty(globalThis, "navigator", original);
			else Reflect.deleteProperty(globalThis, "navigator");
		},
	};
}
test("completed and explicitly discarded exports release Worker spool references", async () => {
	const fixture = withSpoolDirectory();
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	const worker = new RecoveryWorkerFiles("owner", async (message) => {
		if (message.type === "recoveryCancel") {
			registry.cancel(message);
			return undefined;
		}
		return registry.invoke(message);
	});
	const discard = RecoverySpool.prototype.discard;
	let discards = 0;
	RecoverySpool.prototype.discard = async function () {
		discards++;
		return discard.call(this);
	};
	try {
		for (let i = 0; i < 140; i++) {
			const capabilityId = registry.grantSink("a");
			const base = { accountId: "a", recoveryId: `r${i}`, capabilityId };
			await worker.invoke(
				{ ...base, type: "sinkWrite" },
				new Uint8Array([1, 2, 3]),
			);
			if (i % 2 === 0) {
				await worker.invoke({ ...base, type: "sinkCommit" });
				await registry.release(capabilityId);
			} else await worker.invoke({ ...base, type: "sinkDiscard" });
		}
		const beforeClose = discards;
		await worker.close();
		expect(discards).toBe(beforeClose);
		expect(fixture.disk.files.size).toBe(0);
	} finally {
		RecoverySpool.prototype.discard = discard;
		fixture.restore();
	}
});
test("a new presentation owner discovers retained encrypted files with bounded listing and explicit removal", async () => {
	const fixture = withSpoolDirectory();
	try {
		for (let i = 0; i < 130; i++)
			fixture.disk.files.set(`old-${i}.btrrec`, new Uint8Array([1, 2, 3]));
		fixture.disk.files.set("unrelated.txt", new Uint8Array([9]));
		const registry = new RecoveryFileRegistry();
		registry.prepare("new-owner");
		const first = await registry.listRetained();
		expect(first.files).toHaveLength(128);
		expect(first.limited).toBe(true);
		expect(fixture.disk.files.size).toBe(131);
		const sample = first.files[0];
		if (!sample) throw new Error("missing retained file");
		expect(
			new Uint8Array(
				await registry.prepared(sample.capabilityId).file.arrayBuffer(),
			),
		).toEqual(new Uint8Array([1, 2, 3]));
		registry.downloadRequested(sample.capabilityId);
		expect(registry.prepared(sample.capabilityId).state).toBe(
			"downloadRequested",
		);
		for (const file of first.files) await registry.release(file.capabilityId);
		const next = await registry.listRetained();
		expect(next.files).toHaveLength(2);
		expect(next.limited).toBe(false);
		expect(fixture.disk.files.get("unrelated.txt")).toEqual(
			new Uint8Array([9]),
		);
	} finally {
		fixture.restore();
	}
});

test("retained-file discovery and removal cannot race any live recovery writer", async () => {
	const fixture = withSpoolDirectory();
	try {
		fixture.disk.files.set("old.btrrec", new Uint8Array([1, 2, 3]));
		const registry = new RecoveryFileRegistry();
		registry.prepare("reader");
		const listing = await registry.listRetained();
		expect(listing.files).toHaveLength(1);
		const lease = await acquireStorageFamilyLease("maintenance");
		if (!lease) throw new Error("missing lease");
		try {
			await expect(registry.listRetained()).rejects.toMatchObject({
				reason: "busy",
			});
			await expect(registry.release("old")).rejects.toMatchObject({
				reason: "busy",
			});
			expect(fixture.disk.files.get("old.btrrec")).toEqual(
				new Uint8Array([1, 2, 3]),
			);
		} finally {
			await lease.release();
		}
		expect((await registry.listRetained()).files).toHaveLength(1);
		await registry.release("old");
		expect(fixture.disk.files.size).toBe(0);
	} finally {
		fixture.restore();
	}
});

test("source size admission exposes the archive bound before granting or reading", () => {
	const registry = new RecoveryFileRegistry();
	registry.prepare("owner");
	const file = new File([new Uint8Array([1])], "oversized.btrrec");
	Object.defineProperty(file, "size", {
		value: 1024 * 1024 * 1024 + 1024 * 1024 + 1,
	});
	try {
		registry.grantSource("a", file);
		throw new Error("expected refusal");
	} catch (error) {
		expect(error).toMatchObject({
			code: "SIZE_REJECTED",
			recoveryBound: "archiveBytes",
		});
	}
});
