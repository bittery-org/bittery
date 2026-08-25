import { describe, expect, test } from "bun:test";

import { OpfsUploadSpoolRoot } from "./opfs-upload-spool-internal";

class MemoryWritable {
	private chunks: Uint8Array[] = [];

	constructor(
		private readonly handle: MemoryFileHandle,
		keepExistingData: boolean,
	) {
		if (keepExistingData) this.chunks.push(handle.bytes.slice());
	}

	async write(data: Uint8Array): Promise<void> {
		this.handle.writes.push(data.byteLength);
		this.chunks.push(data.slice());
	}

	async close(): Promise<void> {
		const size = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		this.handle.bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of this.chunks) {
			this.handle.bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}

	async abort(): Promise<void> {}
}

class MemoryFileHandle {
	bytes: Uint8Array;
	readonly writes: number[] = [];
	readonly keepExistingDataOptions: boolean[] = [];

	constructor(bytes = new Uint8Array()) {
		this.bytes = bytes;
	}

	async createWritable(options?: {
		keepExistingData?: boolean;
	}): Promise<MemoryWritable> {
		const keepExistingData = options?.keepExistingData ?? false;
		this.keepExistingDataOptions.push(keepExistingData);
		return new MemoryWritable(this, keepExistingData);
	}

	async getFile(): Promise<File> {
		return new File([this.bytes], "opaque.ciphertext");
	}
}

class MemoryDirectory {
	readonly directories = new Map<string, MemoryDirectory>();
	readonly files = new Map<string, MemoryFileHandle>();
	readonly removedNames: string[] = [];

	async getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<MemoryDirectory> {
		const existing = this.directories.get(name);
		if (existing !== undefined) return existing;
		if (!options?.create) throw new DOMException("missing", "NotFoundError");
		const directory = new MemoryDirectory();
		this.directories.set(name, directory);
		return directory;
	}

	async getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<MemoryFileHandle> {
		const existing = this.files.get(name);
		if (existing !== undefined) return existing;
		if (!options?.create) throw new DOMException("missing", "NotFoundError");
		const file = new MemoryFileHandle();
		this.files.set(name, file);
		return file;
	}

	async removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name) && !this.directories.delete(name)) {
			throw new DOMException("missing", "NotFoundError");
		}
		this.removedNames.push(name);
	}

	async *values(): AsyncIterable<{ name: string }> {
		for (const name of [...this.files.keys(), ...this.directories.keys()])
			yield { name };
	}
}

class SerialLocks {
	readonly requests: string[] = [];
	private readonly tails = new Map<string, Promise<void>>();

	async request<T>(
		name: string,
		_options: { mode: "exclusive" },
		callback: () => Promise<T>,
	): Promise<T> {
		this.requests.push(name);
		const previous = this.tails.get(name) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tails.set(
			name,
			previous.then(() => current),
		);
		await previous;
		try {
			return await callback();
		} finally {
			release();
		}
	}
}

const scope = {
	accountId: "account-a",
	operationId: "operation-a",
	attachmentId: "attachment-a",
	artifactId: "artifact-a",
	generation: "generation-a",
};

function chunks(...values: number[][]): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (const value of values) yield new Uint8Array(value);
	})();
}

function fixture() {
	const directory = new MemoryDirectory();
	const locks = new SerialLocks();
	return {
		directory,
		locks,
		root: OpfsUploadSpoolRoot.fromHandlesForTesting(directory, locks),
	};
}

function onlyAccountDirectory(directory: MemoryDirectory): MemoryDirectory {
	const accountDirectory = [...directory.directories.values()][0];
	if (accountDirectory === undefined)
		throw new Error("expected an Account spool directory");
	return accountDirectory;
}

describe("OPFS upload spool", () => {
	test("writes bounded ciphertext chunks and exposes the exact File only inside its lifecycle callback", async () => {
		const { directory, root } = fixture();
		const result = await root.withUploadFile(
			scope,
			6,
			4,
			chunks([1, 2, 3], [4, 5, 6]),
			async (file) => {
				expect(file.size).toBe(6);
				expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
					1, 2, 3, 4, 5, 6,
				]);
				const handle = [...onlyAccountDirectory(directory).files.values()][0];
				if (handle === undefined) throw new Error("expected a spool file");
				expect(handle.writes).toEqual([3, 3]);
			},
		);
		expect(result).toBeUndefined();
		expect(onlyAccountDirectory(directory).files.size).toBe(0);
	});

	test("rejects wrong lengths and oversized chunks before File consumption", async () => {
		for (const values of [[[1, 2]], [[1, 2, 3, 4, 5]]]) {
			const { directory, root } = fixture();
			let consumed = false;
			await expect(
				root.withUploadFile(scope, 4, 4, chunks(...values), async () => {
					consumed = true;
				}),
			).rejects.toThrow();
			expect(consumed).toBe(false);
			expect(onlyAccountDirectory(directory).files.size).toBe(0);
		}
	});

	test("a new root truncates and rebuilds a stale partial physical generation", async () => {
		const { directory, locks, root } = fixture();
		await root.withUploadFile(scope, 2, 2, chunks([1, 2]), async () => {});
		const accountDirectory = onlyAccountDirectory(directory);
		const physicalName = accountDirectory.removedNames[0];
		if (physicalName === undefined)
			throw new Error("expected deterministic physical name");
		const stale = new MemoryFileHandle(new Uint8Array([99, 98, 97]));
		accountDirectory.files.set(physicalName, stale);

		const restartedRoot = OpfsUploadSpoolRoot.fromHandlesForTesting(
			directory,
			locks,
		);
		await restartedRoot.withUploadFile(
			scope,
			4,
			2,
			chunks([4, 5], [6, 7]),
			async (file) => {
				expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
					4, 5, 6, 7,
				]);
			},
		);
		expect(stale.keepExistingDataOptions).toEqual([false]);
		expect(stale.writes).toEqual([2, 2]);
	});

	test("an interrupted File consumer cleans its generation before restart", async () => {
		const { directory, locks, root } = fixture();
		await expect(
			root.withUploadFile(scope, 2, 2, chunks([1, 2]), async () => {
				throw new Error("upload attempt aborted");
			}),
		).rejects.toThrow("upload attempt aborted");
		expect(onlyAccountDirectory(directory).files.size).toBe(0);

		const restartedRoot = OpfsUploadSpoolRoot.fromHandlesForTesting(
			directory,
			locks,
		);
		await restartedRoot.withUploadFile(
			scope,
			2,
			2,
			chunks([3, 4]),
			async (file) => {
				expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
					3, 4,
				]);
			},
		);
	});

	test("same and delayed generations, cleanup, and sweep cannot race an active File callback", async () => {
		const { directory, root } = fixture();
		let releaseFirst = () => {};
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markFirstEntered = () => {};
		const firstEntered = new Promise<void>((resolve) => {
			markFirstEntered = resolve;
		});
		const laterEntries: string[] = [];
		const first = root.withUploadFile(
			scope,
			2,
			2,
			chunks([1, 2]),
			async (file) => {
				markFirstEntered();
				await firstCanFinish;
				expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
					1, 2,
				]);
				expect(onlyAccountDirectory(directory).files.size).toBe(1);
			},
		);
		await firstEntered;

		const sameGeneration = root.withUploadFile(
			scope,
			2,
			2,
			chunks([3, 4]),
			async () => {
				laterEntries.push("same");
			},
		);
		const delayedGeneration = root.withUploadFile(
			{ ...scope, generation: "generation-b" },
			2,
			2,
			chunks([5, 6]),
			async () => {
				laterEntries.push("delayed");
			},
		);
		const cleanup = root
			.cleanup(scope)
			.then(() => laterEntries.push("cleanup"));
		const sweep = root
			.deleteExclusiveAccountOrphans(scope.accountId)
			.then(() => laterEntries.push("sweep"));
		await Promise.resolve();
		expect(laterEntries).toEqual([]);
		releaseFirst();
		await Promise.all([
			first,
			sameGeneration,
			delayedGeneration,
			cleanup,
			sweep,
		]);
		expect(laterEntries.sort()).toEqual([
			"cleanup",
			"delayed",
			"same",
			"sweep",
		]);
	});

	test("uses actual opaque file keys, isolates Accounts, and sweeps idempotently on the Account lock", async () => {
		const { directory, locks, root } = fixture();
		for (const accountId of ["account-a", "account-b"]) {
			const accountScope = { ...scope, accountId };
			await root.withUploadFile(accountScope, 1, 1, chunks([1]), async () => {
				const directoryKeys = [...directory.directories.keys()];
				const fileKeys = [...directory.directories.values()].flatMap(
					(entry) => [...entry.files.keys()],
				);
				const physicalKeys = [...directoryKeys, ...fileKeys].join(" ");
				for (const identifier of Object.values(accountScope)) {
					expect(physicalKeys).not.toContain(identifier);
				}
			});
		}
		expect(directory.directories.size).toBe(2);
		const accountDirectories = [...directory.directories.values()];
		accountDirectories[0]?.files.set(
			"opaque-orphan",
			new MemoryFileHandle(new Uint8Array([1])),
		);
		expect(await root.deleteExclusiveAccountOrphans("account-a")).toBe(1);
		expect(await root.deleteExclusiveAccountOrphans("account-a")).toBe(0);
		expect(accountDirectories.map((entry) => entry.files.size).sort()).toEqual([
			0, 0,
		]);
		expect(new Set(locks.requests)).toHaveLength(2);
	});

	test("explicit cleanup is idempotent and requires every scope identifier", async () => {
		const { root } = fixture();
		await root.cleanup(scope);
		await root.cleanup(scope);
		await expect(
			root.withUploadFile(
				{ ...scope, operationId: "" },
				1,
				1,
				chunks([1]),
				async () => {},
			),
		).rejects.toThrow("operationId must not be empty");
	});
});
