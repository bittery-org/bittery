import type {
	RecoveryControlRequest,
	RecoveryControlResponse,
} from "../generated/recovery-control/contract";
import {
	validateRecoveryControlRequest,
	validateRecoveryControlResponse,
} from "../generated/recovery-control/validator";
import { IndexedDbStorageError } from "./indexeddb-lifecycle";
import { addRecoveryArtifact } from "./indexeddb-recovery-artifacts";
import {
	RecoveryAccountReader,
	RecoveryRecordReader,
} from "./indexeddb-recovery-records";
import { RecoveryRepairStage } from "./indexeddb-recovery-stage";
import { waitRecovery } from "./recovery-cancellation";
import {
	assertRecoveryTextBound,
	RECOVERY_CONTROL_BYTES,
	recoveryJson,
} from "./recovery-json";
import { RecoveryLimitError } from "./recovery-limit";
import type { WebStorageFamily } from "./web-storage-family";
import { StorageMaintenanceError } from "./web-storage-maintenance";

type Transfer = Extract<RecoveryControlRequest, { capabilityId: string }>;
export type RecoveryExecutorResult = {
	controlResponseJson: string;
	binaryChunk?: Uint8Array;
};
export type RecoveryTransfer = (
	request: Transfer,
	binaryChunk?: Uint8Array,
	signal?: AbortSignal,
) => Promise<{ control: RecoveryControlResponse; binaryChunk?: Uint8Array }>;

/** Fixed storage family and opaque source/sink capabilities; all recovery policy remains in Core. */
export class WebRecoveryExecutor {
	#recoveryId?: string;
	#reader = new RecoveryRecordReader();
	#accounts = new RecoveryAccountReader();
	readonly #stage = new RecoveryRepairStage(() => this.#activeSignal);
	#activeSignal?: AbortSignal;
	#controller?: AbortController;
	#pending?: Promise<unknown>;
	#closed = false;
	constructor(
		private readonly family: WebStorageFamily,
		private readonly transfer: RecoveryTransfer,
	) {}
	cancel(recoveryId: string): void {
		if (this.#recoveryId === recoveryId) this.#controller?.abort();
	}
	async invoke(
		controlJson: string,
		binaryChunk?: Uint8Array,
	): Promise<RecoveryExecutorResult> {
		if (this.#closed)
			return answer({ type: "unavailable", reason: "cancelled" });
		if (this.#pending !== undefined)
			return answer({ type: "unavailable", reason: "busy" });
		if (controlJson.length > RECOVERY_CONTROL_BYTES)
			return answer({ type: "limitExceeded", bound: "controlBytes" });
		let value: unknown;
		try {
			assertRecoveryTextBound(
				controlJson,
				RECOVERY_CONTROL_BYTES,
				"controlBytes",
			);
			value = JSON.parse(controlJson);
		} catch (error) {
			if (error instanceof RecoveryLimitError)
				return answer({ type: "limitExceeded", bound: error.recoveryBound });
			return answer({ type: "unavailable", reason: "corrupt" });
		}
		if (!validateRecoveryControlRequest(value))
			return answer({ type: "unavailable", reason: "corrupt" });
		const request = value;
		const hasBytes =
			request.type === "stageRowChunk" ||
			request.type === "sinkWrite" ||
			(request.type === "addArtifactEntry" &&
				["artifactChunk", "provisionalChunk", "vaultImageChunk"].includes(
					request.record.type,
				));
		if (binaryChunk !== undefined && binaryChunk.byteLength > 262144)
			return answer({ type: "limitExceeded", bound: "chunkBytes" });
		if (
			hasBytes !== (binaryChunk !== undefined) ||
			(binaryChunk !== undefined && binaryChunk.byteLength === 0)
		)
			return answer({ type: "unavailable", reason: "corrupt" });
		const cleanup = [
			"leaveMaintenance",
			"sourceClose",
			"sinkDiscard",
			"discardRepairStage",
		].includes(request.type);
		if (
			!cleanup &&
			this.#recoveryId === request.recoveryId &&
			this.#controller?.signal.aborted
		)
			return answer({ type: "unavailable", reason: "cancelled" });
		if (request.type === "enterMaintenance" && this.#recoveryId === undefined) {
			this.#recoveryId = request.recoveryId;
			this.#controller = new AbortController();
		}
		this.#activeSignal = cleanup ? undefined : this.#controller?.signal;
		const task = this.#invoke(request, binaryChunk);
		this.#pending = task;
		try {
			const result = await task;
			if (this.#activeSignal?.aborted && result.control.type !== "repaired") {
				result.binaryChunk?.fill(0);
				return answer({ type: "unavailable", reason: "cancelled" });
			}
			if (!validateRecoveryControlResponse(result.control))
				throw new Error("Invalid recovery response");
			return {
				...answer(result.control),
				...(result.binaryChunk === undefined
					? {}
					: { binaryChunk: result.binaryChunk }),
			};
		} catch (error) {
			if (!this.#activeSignal?.aborted && error instanceof RecoveryLimitError)
				return answer({ type: "limitExceeded", bound: error.recoveryBound });
			let reason: Extract<
				RecoveryControlResponse,
				{ type: "unavailable" }
			>["reason"] = "corrupt";
			if (
				this.#activeSignal?.aborted ||
				(error instanceof DOMException && error.name === "AbortError")
			)
				reason = "cancelled";
			else if (error instanceof IndexedDbStorageError) {
				reason =
					error.reason === "unsupported_version"
						? "unsupportedSchema"
						: error.reason === "blocked"
							? "busy"
							: "storageUnavailable";
			} else if (error instanceof StorageMaintenanceError) {
				reason =
					error.reason === "unavailable" ? "storageUnavailable" : error.reason;
			} else if (
				error instanceof DOMException &&
				error.name === "QuotaExceededError"
			)
				reason = "quota";
			return answer({ type: "unavailable", reason });
		} finally {
			this.#pending = undefined;
			this.#activeSignal = undefined;
		}
	}
	async #invoke(
		request: RecoveryControlRequest,
		binaryChunk?: Uint8Array,
	): Promise<{ control: RecoveryControlResponse; binaryChunk?: Uint8Array }> {
		if (request.type === "enterMaintenance") {
			if (this.#recoveryId !== request.recoveryId)
				throw new StorageMaintenanceError("busy");
			const physicalSchemas = await this.family.enterMaintenance(
				this.#activeSignal,
			);
			return { control: { type: "maintenanceEntered", physicalSchemas } };
		}
		if (request.type === "leaveMaintenance" && this.#recoveryId === undefined)
			return { control: { type: "maintenanceLeft" } };
		if (this.#recoveryId !== request.recoveryId)
			throw new Error("Recovery maintenance scope is invalid");
		if (request.type === "leaveMaintenance") {
			await this.#stage.close();
			await this.family.leaveMaintenance();
			this.#controller = undefined;
			this.#recoveryId = undefined;
			this.#reader = new RecoveryRecordReader();
			this.#accounts = new RecoveryAccountReader();
			return { control: { type: "maintenanceLeft" } };
		}
		return this.family.runMaintenance(async () => {
			this.#activeSignal?.throwIfAborted();
			if ("capabilityId" in request)
				return waitRecovery(
					this.transfer(request, binaryChunk, this.#activeSignal),
					this.#activeSignal,
					(result) => result.binaryChunk?.fill(0),
				);
			if (request.type === "listAccounts")
				return this.#accounts.read(request.cursor, this.#activeSignal);
			const { accountId, recoveryId } = request;
			switch (request.type) {
				case "readEntry":
					return this.#reader.read(
						accountId,
						request.cursor,
						this.#activeSignal,
					);
				case "addArtifactEntry":
					await addRecoveryArtifact(
						accountId,
						request.record,
						binaryChunk,
						this.#activeSignal,
					);
					return { control: { type: "artifactAdded" } };
				case "beginRepairStage":
					await this.#stage.begin(recoveryId, accountId);
					return { control: { type: "repairStageBegun" } };
				case "stageExpectedRow":
					await this.#stage.expected(recoveryId, accountId, request.row);
					return { control: { type: "expectedRowStaged" } };
				case "stageRowStart":
					await this.#stage.start(
						recoveryId,
						accountId,
						request.store,
						request.recordId,
						request.payloadByteLength,
					);
					return { control: { type: "rowStarted" } };
				case "stageRowChunk":
					if (binaryChunk === undefined)
						throw new Error("Missing recovery chunk");
					await this.#stage.chunk(recoveryId, accountId, binaryChunk);
					return { control: { type: "rowChunkStaged" } };
				case "stageRowEnd":
					await this.#stage.end(recoveryId, accountId);
					return { control: { type: "rowEnded" } };
				case "commitRepair":
					return { control: { type: await this.#stage.commit(request) } };
				case "discardRepairStage":
					await this.#stage.discard(recoveryId, accountId);
					return { control: { type: "repairStageDiscarded" } };
			}
		});
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.#controller?.abort();
		await this.#pending?.catch(() => undefined);
		await this.#stage.close();
	}
}
function answer(control: RecoveryControlResponse): RecoveryExecutorResult {
	return { controlResponseJson: recoveryJson(control) };
}
