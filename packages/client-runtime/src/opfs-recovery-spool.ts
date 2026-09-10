import { RecoveryLimitError } from "./recovery-limit";
/** Ciphertext-only temporary files. The existing dedicated Runtime Worker owns writes. */
export const RECOVERY_SPOOL_DIRECTORY = "bittery-encrypted-recovery-v1";
const CHUNK_BYTES = 256 * 1024;
// Header/frame overhead is bounded separately from Core's 1-GiB plaintext budget.
const MAX_ENCRYPTED_BYTES = 1024 * 1024 * 1024 + 1024 * 1024;

type SyncHandle = {
	write(bytes: Uint8Array, options: { at: number }): number | Promise<number>;
	flush(): void | Promise<void>;
	close(): void | Promise<void>;
};
type FileHandle = {
	createSyncAccessHandle?(): Promise<SyncHandle>;
	getFile(): Promise<File>;
};
export type RecoverySpoolDirectory = {
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<FileHandle>;
	removeEntry(name: string): Promise<void>;
	entries?(): AsyncIterableIterator<[string, { kind: string }]>;
};
function filename(id: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
		throw new Error("Invalid recovery file identity");
	return `${id}.btrrec`;
}
export async function openRecoverySpoolDirectory(): Promise<RecoverySpoolDirectory> {
	if (typeof navigator.storage?.getDirectory !== "function")
		throw new Error("Encrypted recovery files are unavailable");
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(RECOVERY_SPOOL_DIRECTORY, {
		create: true,
	}) as Promise<RecoverySpoolDirectory>;
}

/** A failed write retires the file. Preparation hands off immutable bytes, never claims they were saved externally. */
export class RecoverySpool {
	#offset = 0;
	#state: "writing" | "prepared" | "discarded" = "writing";
	#busy = false;
	private constructor(
		private readonly directory: RecoverySpoolDirectory,
		private readonly name: string,
		private readonly file: FileHandle,
		private handle: SyncHandle | undefined,
	) {}
	static async create(
		directory: RecoverySpoolDirectory,
		id: string,
	): Promise<RecoverySpool> {
		const name = filename(id);
		try {
			await directory.getFileHandle(name);
			throw new Error("Recovery file already exists");
		} catch (error) {
			if (!(error instanceof DOMException) || error.name !== "NotFoundError")
				throw error;
		}
		const file = await directory.getFileHandle(name, { create: true });
		try {
			if (typeof file.createSyncAccessHandle !== "function")
				throw new Error("Synchronous recovery file writes are unavailable");
			return new RecoverySpool(
				directory,
				name,
				file,
				await file.createSyncAccessHandle(),
			);
		} catch (error) {
			await directory.removeEntry(name);
			throw error;
		}
	}
	async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
		if (this.#state !== "writing" || this.#busy || this.handle === undefined)
			throw new Error("Recovery file is not writable");
		this.#busy = true;
		try {
			if (bytes.byteLength > CHUNK_BYTES)
				throw new RecoveryLimitError("chunkBytes");
			if (this.#offset + bytes.byteLength > MAX_ENCRYPTED_BYTES)
				throw new RecoveryLimitError("archiveBytes");
			if (bytes.byteLength === 0)
				throw new Error("Recovery file write is empty");
			let consumed = 0;
			while (consumed < bytes.byteLength) {
				signal?.throwIfAborted();
				const count = await this.handle.write(bytes.subarray(consumed), {
					at: this.#offset + consumed,
				});
				if (
					!Number.isInteger(count) ||
					count <= 0 ||
					count > bytes.byteLength - consumed
				)
					throw new Error("Recovery file write made invalid progress");
				consumed += count;
			}
			signal?.throwIfAborted();
			this.#offset += consumed;
		} catch (error) {
			await this.#discard();
			throw error;
		} finally {
			this.#busy = false;
		}
	}
	async prepare(signal?: AbortSignal): Promise<File> {
		if (this.#state !== "writing" || this.#busy || this.handle === undefined)
			throw new Error("Recovery file cannot be prepared");
		this.#busy = true;
		try {
			signal?.throwIfAborted();
			await this.handle.flush();
			await this.handle.close();
			this.handle = undefined;
			const file = await this.file.getFile();
			if (file.size !== this.#offset)
				throw new Error("Recovery file length changed");
			signal?.throwIfAborted();
			this.#state = "prepared";
			return file;
		} catch (error) {
			await this.#discard();
			throw error;
		} finally {
			this.#busy = false;
		}
	}
	async discard(): Promise<void> {
		if (this.#busy) throw new Error("Recovery file is busy");
		if (this.#state === "writing") await this.#discard();
	}
	async #discard(): Promise<void> {
		this.#state = "discarded";
		try {
			await this.handle?.close();
		} finally {
			this.handle = undefined;
			await this.directory.removeEntry(this.name);
		}
	}
	/** Only an explicit presentation action releases a prepared/download-requested file. */
	static async release(
		directory: RecoverySpoolDirectory,
		id: string,
	): Promise<void> {
		await directory.removeEntry(filename(id));
	}
	static async preparedFile(
		directory: RecoverySpoolDirectory,
		id: string,
	): Promise<File> {
		return (await directory.getFileHandle(filename(id))).getFile();
	}
}
