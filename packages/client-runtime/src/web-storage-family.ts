import type { RecoveryPhysicalSchemas } from "../generated/recovery-control/contract";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import { openReplicaDatabase } from "./indexeddb-executor-internal";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";
import {
	acquireStorageFamilyLease,
	type StorageFamilyLease,
	StorageMaintenanceError,
} from "./web-storage-maintenance";

/** Held by the one Worker owner, including failed-open recovery and final drained shutdown. */
export class WebStorageFamily {
	#lease?: StorageFamilyLease;
	#mode: "idle" | "normal" | "maintenance" = "idle";
	#transition?: Promise<unknown>;
	readonly #pending = new Set<Promise<unknown>>();
	constructor(private readonly closeStores: () => Promise<void>) {}
	async open(signal?: AbortSignal): Promise<void> {
		if (this.#transition !== undefined) {
			await this.#transition;
			if (this.#mode !== "normal") throw new StorageMaintenanceError("busy");
			return;
		}
		if (this.#mode === "normal") return;
		if (this.#mode !== "idle") throw new StorageMaintenanceError("busy");
		this.#transition = this.#acquire("normal", signal);
		try {
			await this.#transition;
		} finally {
			this.#transition = undefined;
		}
	}
	/** Core calls only after every normal writer, transfer and sweep has drained. */
	async enterMaintenance(
		signal?: AbortSignal,
	): Promise<RecoveryPhysicalSchemas> {
		if (this.#transition !== undefined || this.#mode === "maintenance")
			throw new StorageMaintenanceError("busy");
		const transition = (async () => {
			await this.#release();
			return await this.#acquire("maintenance", signal);
		})();
		this.#transition = transition;
		try {
			return await transition;
		} finally {
			this.#transition = undefined;
		}
	}
	async leaveMaintenance(): Promise<void> {
		if (this.#transition !== undefined)
			throw new StorageMaintenanceError("busy");
		if (this.#mode === "idle") return;
		if (this.#mode !== "maintenance") throw new StorageMaintenanceError("busy");
		this.#transition = this.#release();
		try {
			await this.#transition;
		} finally {
			this.#transition = undefined;
		}
	}
	/** Called after Runtime close/drain, never as cancellation of accepted work. */
	runNormal<T>(operation: () => Promise<T>): Promise<T> {
		return this.#run("normal", operation);
	}
	runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
		return this.#run("maintenance", operation);
	}
	#run<T>(
		mode: "normal" | "maintenance",
		operation: () => Promise<T>,
	): Promise<T> {
		if (this.#mode !== mode || this.#transition !== undefined)
			return Promise.reject(new StorageMaintenanceError("busy"));
		const task = Promise.resolve().then(operation);
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
		return task;
	}
	async close(): Promise<void> {
		const previous = this.#transition;
		const transition = (async () => {
			await previous?.catch(() => undefined);
			await this.#release();
		})();
		this.#transition = transition;
		try {
			await transition;
		} finally {
			if (this.#transition === transition) this.#transition = undefined;
		}
	}

	async #acquire(
		mode: "normal" | "maintenance",
		signal?: AbortSignal,
	): Promise<RecoveryPhysicalSchemas> {
		const lease = await acquireStorageFamilyLease(mode, signal);
		this.#lease = lease;
		try {
			// No maintenance becomes available until all prior-build version barriers succeeded.
			const versions: RecoveryPhysicalSchemas = {
				replicaVersion: 0,
				attachmentArtifactsVersion: 0,
				vaultImagesVersion: 0,
			};
			for (const [field, open] of [
				["replicaVersion", openReplicaDatabase],
				["attachmentArtifactsVersion", openAttachmentArtifactDatabase],
				["vaultImagesVersion", openVaultImageArtifactDatabase],
			] as const) {
				signal?.throwIfAborted();
				const database = await open();
				versions[field] = database.version;
				database.close();
				signal?.throwIfAborted();
			}
			this.#mode = mode;
			return versions;
		} catch (error) {
			await this.#release();
			throw error;
		}
	}
	async #release() {
		await Promise.allSettled([...this.#pending]);
		await this.closeStores();
		await this.#lease?.release();
		this.#lease = undefined;
		this.#mode = "idle";
	}
}
