/** One fixed exclusion boundary covers every durable Runtime store and its sweep callbacks. */
const FAMILY = "bittery:runtime-storage-family";

export interface StorageFamilyLease {
	/** Resolves only after the browser's lock callback has completed. */
	release(): Promise<void>;
}

export class StorageMaintenanceError extends Error {
	readonly code = "STORAGE_UNAVAILABLE";
	constructor(readonly reason: "unsupported" | "busy" | "unavailable") {
		super(
			reason === "busy"
				? "Close other Bittery tabs before storage recovery."
				: "Storage maintenance is unavailable.",
		);
		this.name = "StorageMaintenanceError";
	}
}

/** Unsupported maintenance does not remove ordinary IndexedDB browser support. */
export async function acquireStorageFamilyLease(
	mode: "normal" | "maintenance",
	signal?: AbortSignal,
	manager?: Pick<LockManager, "request"> | null,
): Promise<StorageFamilyLease | undefined> {
	if (signal?.aborted)
		throw new DOMException("Storage admission cancelled", "AbortError");
	let lockManager: Pick<LockManager, "request"> | null | undefined;
	try {
		lockManager = manager === undefined ? globalThis.navigator?.locks : manager;
	} catch {
		throw new StorageMaintenanceError("unavailable");
	}
	if (lockManager === undefined || lockManager === null) {
		if (mode === "normal") return undefined;
		throw new StorageMaintenanceError("unsupported");
	}
	let resolveAdmission!: (lease: StorageFamilyLease) => void;
	let rejectAdmission!: (error: unknown) => void;
	const admission = new Promise<StorageFamilyLease>((resolve, reject) => {
		resolveAdmission = resolve;
		rejectAdmission = reject;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let request: Promise<unknown>;
	try {
		request = lockManager.request(
			FAMILY,
			{ mode: mode === "normal" ? "shared" : "exclusive", ifAvailable: true },
			async (lock) => {
				if (signal?.aborted) {
					rejectAdmission(
						new DOMException("Storage admission cancelled", "AbortError"),
					);
					return;
				}
				if (lock === null) {
					rejectAdmission(new StorageMaintenanceError("busy"));
					return;
				}
				resolveAdmission({
					async release() {
						release();
						await request;
					},
				});
				await held;
			},
		);
	} catch {
		throw new StorageMaintenanceError("unavailable");
	}
	void request.catch(() =>
		rejectAdmission(new StorageMaintenanceError("unavailable")),
	);
	const lease = await admission;
	// Cancellation between browser admission and this continuation cannot leak a shared owner.
	if (signal?.aborted) {
		await lease.release();
		throw new DOMException("Storage admission cancelled", "AbortError");
	}
	return lease;
}
