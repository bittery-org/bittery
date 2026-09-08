/** All Runtime databases refuse delayed/unsupported upgrades without resetting stored bytes. */
export class IndexedDbStorageError extends Error {
	readonly code = "STORAGE_UNAVAILABLE";
	constructor(
		readonly reason:
			| "blocked"
			| "upgrade_failed"
			| "unsupported_version"
			| "unavailable",
	) {
		super(
			"Replica storage is unavailable. Close other Bittery tabs and retry.",
		);
		this.name = "StorageUnavailableError";
	}
}

export async function openIndexedDatabase(options: {
	name: string;
	version: number;
	upgrade(
		database: IDBDatabase,
		transaction: IDBTransaction,
		oldVersion: number,
	): void;
	validate?(database: IDBDatabase, transaction?: IDBTransaction): void;
	onVersionChange?(): void;
}): Promise<IDBDatabase> {
	if (typeof globalThis.indexedDB === "undefined")
		throw new IndexedDbStorageError("unavailable");
	return new Promise((resolve, reject) => {
		let abandoned = false;
		let upgrading = false;
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(options.name, options.version);
		} catch {
			reject(new IndexedDbStorageError("unavailable"));
			return;
		}
		request.onblocked = () => {
			abandoned = true;
			reject(new IndexedDbStorageError("blocked"));
		};
		request.onupgradeneeded = (event) => {
			if (abandoned) {
				request.transaction?.abort();
				return;
			}
			upgrading = true;
			try {
				if (request.transaction === null)
					throw new IndexedDbStorageError("upgrade_failed");
				options.upgrade(request.result, request.transaction, event.oldVersion);
				options.validate?.(request.result, request.transaction);
			} catch (error) {
				request.transaction?.abort();
				reject(
					error instanceof IndexedDbStorageError
						? error
						: new IndexedDbStorageError("upgrade_failed"),
				);
			}
		};
		request.onerror = () =>
			reject(
				new IndexedDbStorageError(
					request.error?.name === "VersionError"
						? "unsupported_version"
						: upgrading
							? "upgrade_failed"
							: "unavailable",
				),
			);
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) {
				database.close();
				return;
			}
			database.onversionchange = () => {
				database.close();
				options.onVersionChange?.();
			};
			try {
				options.validate?.(database);
				resolve(database);
			} catch (error) {
				database.close();
				reject(
					error instanceof IndexedDbStorageError
						? error
						: new IndexedDbStorageError("unavailable"),
				);
			}
		};
	});
}

export type IndexedDbStoreLayout = readonly [
	name: string,
	keyPath: string | readonly string[],
	indexes: readonly (readonly [
		name: string,
		keyPath: string | readonly string[],
	])[],
];

/** Validates physical layouts without interpreting any stored Account data. */
export function assertIndexedDbLayout(
	database: IDBDatabase,
	layout: readonly IndexedDbStoreLayout[],
	transaction?: IDBTransaction,
): void {
	if (
		JSON.stringify([...database.objectStoreNames].sort()) !==
		JSON.stringify(layout.map(([name]) => name).sort())
	)
		throw new IndexedDbStorageError("unsupported_version");
	const tx =
		transaction ??
		database.transaction(
			layout.map(([name]) => name),
			"readonly",
		);
	for (const [name, keyPath, indexes] of layout) {
		const store = tx.objectStore(name);
		if (
			store.autoIncrement ||
			JSON.stringify(store.keyPath) !== JSON.stringify(keyPath) ||
			JSON.stringify([...store.indexNames].sort()) !==
				JSON.stringify(indexes.map(([index]) => index).sort())
		)
			throw new IndexedDbStorageError("unsupported_version");
		for (const [indexName, indexKey] of indexes) {
			const index = store.index(indexName);
			if (
				index.unique ||
				index.multiEntry ||
				JSON.stringify(index.keyPath) !== JSON.stringify(indexKey)
			)
				throw new IndexedDbStorageError("unsupported_version");
		}
	}
}
