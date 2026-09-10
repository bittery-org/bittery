export type OpfsUploadSpoolScope = Readonly<{
	accountId: string;
	operationId: string;
	attachmentId: string;
	artifactId: string;
	generation: string;
}>;

type WritableHandle = {
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
};

type FileHandle = {
	createWritable(options?: {
		keepExistingData?: boolean;
	}): Promise<WritableHandle>;
	getFile(): Promise<File>;
};

type DirectoryEntry = { name: string };

type DirectoryHandle = {
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<DirectoryHandle>;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<FileHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterable<DirectoryEntry>;
};

type LockManager = {
	request<T>(
		name: string,
		options: { mode: "shared" | "exclusive" },
		callback: () => Promise<T>,
	): Promise<T>;
};

const SPOOL_DIRECTORY = "bittery-ciphertext-upload-spool-v1";
const DEVICE_LIFECYCLE_LOCK = "bittery-upload-spool-device-lifecycle-v1";

function requireIdentifier(name: string, value: string): string {
	if (value.length === 0) {
		throw new Error(`${name} must not be empty`);
	}
	return value;
}

function encodeField(value: string): string {
	return `${new TextEncoder().encode(value).byteLength}:${value}`;
}

async function opaqueDigest(fields: readonly string[]): Promise<string> {
	const encoded = new TextEncoder().encode(fields.map(encodeField).join(""));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function accountDirectoryName(accountId: string): Promise<string> {
	return `account-${await opaqueDigest([requireIdentifier("accountId", accountId)])}`;
}

function accountLifecycleLockName(directoryName: string): string {
	return `bittery-upload-spool-account-lifecycle-${directoryName}`;
}

async function spoolFileName(scope: OpfsUploadSpoolScope): Promise<string> {
	return `artifact-${await opaqueDigest([
		requireIdentifier("accountId", scope.accountId),
		requireIdentifier("operationId", scope.operationId),
		requireIdentifier("attachmentId", scope.attachmentId),
		requireIdentifier("artifactId", scope.artifactId),
		requireIdentifier("generation", scope.generation),
	])}.ciphertext`;
}

export class OpfsUploadSpoolRoot {
	private constructor(
		private readonly directory: DirectoryHandle,
		private readonly locks: LockManager,
	) {}

	static async open(): Promise<OpfsUploadSpoolRoot> {
		const storage = navigator.storage as StorageManager & {
			getDirectory(): Promise<FileSystemDirectoryHandle>;
		};
		if (
			typeof storage.getDirectory !== "function" ||
			navigator.locks === undefined
		) {
			throw new Error("OPFS and Web Locks are required for the upload spool");
		}
		const originRoot = await storage.getDirectory();
		const directory = await originRoot.getDirectoryHandle(SPOOL_DIRECTORY, {
			create: true,
		});
		return new OpfsUploadSpoolRoot(
			directory as unknown as DirectoryHandle,
			navigator.locks,
		);
	}

	static fromHandlesForTesting(
		directory: DirectoryHandle,
		locks: LockManager,
	): OpfsUploadSpoolRoot {
		return new OpfsUploadSpoolRoot(directory, locks);
	}

	async withUploadFile(
		scope: OpfsUploadSpoolScope,
		expectedByteLength: number,
		maximumChunkByteLength: number,
		chunks: AsyncIterable<Uint8Array>,
		consume: (file: File) => Promise<void>,
	): Promise<void> {
		if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
			throw new Error("expectedByteLength must be a non-negative safe integer");
		}
		if (
			!Number.isSafeInteger(maximumChunkByteLength) ||
			maximumChunkByteLength <= 0
		) {
			throw new Error("maximumChunkByteLength must be a positive safe integer");
		}
		const directoryName = await accountDirectoryName(scope.accountId);
		const fileName = await spoolFileName(scope);
		await this.withAccountLifecycle(directoryName, async () => {
			const accountDirectory = await this.directory.getDirectoryHandle(
				directoryName,
				{ create: true },
			);
			try {
				const file = await writeExactCiphertextFile(
					accountDirectory,
					fileName,
					expectedByteLength,
					maximumChunkByteLength,
					chunks,
				);
				await consume(file);
			} finally {
				await removeFileIfPresent(accountDirectory, fileName);
			}
		});
	}

	async cleanup(scope: OpfsUploadSpoolScope): Promise<void> {
		const directoryName = await accountDirectoryName(scope.accountId);
		const fileName = await spoolFileName(scope);
		await this.withAccountLifecycle(directoryName, async () => {
			let accountDirectory: DirectoryHandle;
			try {
				accountDirectory =
					await this.directory.getDirectoryHandle(directoryName);
			} catch (error) {
				if (isNotFound(error)) return;
				throw error;
			}
			await removeFileIfPresent(accountDirectory, fileName);
		});
	}

	async deleteAccount(accountId: string): Promise<void> {
		const directoryName = await accountDirectoryName(accountId);
		await this.withAccountLifecycle(directoryName, async () => {
			try {
				await this.directory.removeEntry(directoryName, { recursive: true });
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		});
	}

	async wipeDevice(): Promise<void> {
		await this.locks.request(
			DEVICE_LIFECYCLE_LOCK,
			{ mode: "exclusive" },
			async () => {
				for await (const entry of this.directory.values()) {
					await this.directory.removeEntry(entry.name, { recursive: true });
				}
			},
		);
	}

	async deleteExclusiveAccountOrphans(accountId: string): Promise<number> {
		const directoryName = await accountDirectoryName(accountId);
		return this.withAccountLifecycle(directoryName, async () => {
			let accountDirectory: DirectoryHandle;
			try {
				accountDirectory =
					await this.directory.getDirectoryHandle(directoryName);
			} catch (error) {
				if (isNotFound(error)) {
					return 0;
				}
				throw error;
			}

			let deleted = 0;
			for await (const entry of accountDirectory.values()) {
				await accountDirectory.removeEntry(entry.name, { recursive: true });
				deleted += 1;
			}
			return deleted;
		});
	}

	private async withAccountLifecycle<T>(
		directoryName: string,
		callback: () => Promise<T>,
	): Promise<T> {
		return this.locks.request(DEVICE_LIFECYCLE_LOCK, { mode: "shared" }, () =>
			this.locks.request(
				accountLifecycleLockName(directoryName),
				{ mode: "exclusive" },
				callback,
			),
		);
	}
}

function isNotFound(error: unknown): boolean {
	return error instanceof DOMException && error.name === "NotFoundError";
}

async function removeFileIfPresent(
	directory: DirectoryHandle,
	fileName: string,
): Promise<void> {
	try {
		await directory.removeEntry(fileName);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}

async function writeExactCiphertextFile(
	directory: DirectoryHandle,
	fileName: string,
	expectedByteLength: number,
	maximumChunkByteLength: number,
	chunks: AsyncIterable<Uint8Array>,
): Promise<File> {
	let writable: WritableHandle | undefined;
	let written = 0;
	try {
		const handle = await directory.getFileHandle(fileName, {
			create: true,
		});
		writable = await handle.createWritable({ keepExistingData: false });
		for await (const chunk of chunks) {
			if (!(chunk instanceof Uint8Array)) {
				throw new Error("upload spool chunks must be Uint8Array ciphertext");
			}
			if (chunk.byteLength > maximumChunkByteLength) {
				throw new Error("upload spool chunk exceeds the configured bound");
			}
			if (written + chunk.byteLength > expectedByteLength) {
				throw new Error("upload spool exceeds the expected byte length");
			}
			await writable.write(chunk);
			written += chunk.byteLength;
		}
		if (written !== expectedByteLength) {
			throw new Error("upload spool did not reach the expected byte length");
		}
		await writable.close();
		const file = await handle.getFile();
		if (file.size !== expectedByteLength) {
			throw new Error("OPFS returned a file with an unexpected byte length");
		}
		return file;
	} catch (error) {
		await writable?.abort(error).catch(() => undefined);
		await removeFileIfPresent(directory, fileName);
		throw error;
	}
}
