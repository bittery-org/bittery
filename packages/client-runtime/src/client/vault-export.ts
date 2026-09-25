import type {
	ObservationControl,
	VaultExportProjection,
} from "../../generated/runtime-protocol/contract";
import {
	validateObservationControl,
	validateRuntimeProjection,
} from "../../generated/runtime-protocol/validator";
import { RuntimeRequestError, type RuntimeTransport } from "./transport";

export interface RuntimeVaultExportHandle {
	beginOutput(): Promise<string>;
	finishOutput(outputLeaseId: string): Promise<void>;
	/** Acknowledges that this consumer has disposed every owned private reference and task. */
	close(): Promise<void>;
}
export interface RuntimeVaultExportOptions {
	onRetired(control: ObservationControl): void;
}

/** One fixed connection-owned observation, deliberately outside the reusable store registry. */
export async function observeVaultExport(
	transport: RuntimeTransport,
	observationId: string,
	input: { accountId: string; vaultIds: string[] },
	listener: (snapshot: VaultExportProjection) => void,
	options: RuntimeVaultExportOptions,
): Promise<RuntimeVaultExportHandle> {
	const begin = transport.beginVaultExportOutput;
	const finish = transport.finishVaultExportOutput;
	if (!begin || !finish)
		throw new RuntimeRequestError(
			"INVARIANT_VIOLATION",
			"This Runtime transport has no Export output capability",
		);
	let closed = false;
	let disconnected = false;
	let closing: Promise<void> | undefined;
	const handle: RuntimeVaultExportHandle = {
		beginOutput() {
			if (closed)
				return Promise.reject(
					new RuntimeRequestError("CANCELLED", "Export observation is closed"),
				);
			return begin.call(transport, observationId);
		},
		async finishOutput(outputLeaseId) {
			await finish.call(transport, observationId, outputLeaseId);
			closed = true;
		},
		close() {
			if (closed || disconnected) return Promise.resolve();
			if (closing === undefined) {
				closing = transport.unobserve(observationId).then(() => {
					closed = true;
				});
				void closing.catch(() => {
					closing = undefined;
				});
			}
			return closing;
		},
	};
	try {
		await transport.observe(
			observationId,
			JSON.stringify({ type: "vaultExport", ...input }),
			(json) => {
				const projection: unknown = JSON.parse(json);
				if (
					!validateRuntimeProjection(projection) ||
					projection.type !== "vaultExport" ||
					projection.value.accountId !== input.accountId
				)
					throw new RuntimeRequestError(
						"INVARIANT_VIOLATION",
						"Invalid fixed Export snapshot",
					);
				listener(projection.value);
			},
			{
				onControl(json) {
					const control: unknown = JSON.parse(json);
					if (!validateObservationControl(control))
						throw new RuntimeRequestError(
							"INVARIANT_VIOLATION",
							"Invalid Export retirement control",
						);
					disconnected ||= control.reason === "connectionClosed";
					options.onRetired(control);
				},
			},
		);
		return handle;
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}
