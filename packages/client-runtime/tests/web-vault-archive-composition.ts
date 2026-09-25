// The actual hook's crypto import resolves here only in the joined archive acceptance build.
// All consumers share this one real composition; no policy or Runtime response is substituted.
import { createRuntimeClient } from "../src/client";
import { createWebClientRuntime } from "../src/web/composition";

export let workersCreated = 0;
let worker: Worker | undefined;
export const composition = createWebClientRuntime({
	createWorker: () => {
		workersCreated += 1;
		worker = new Worker(
			`/create-vault-worker.js?exportLoss=1&archiveAttachment=${new URL(location.href).searchParams.get("attachment") ?? "0"}`,
			{ type: "module" },
		);
		return worker;
	},
});
export let provisionalAttachmentBytes = 0;
export let attachmentDiscards = 0;
export const attachmentDownloadSinks = {
	...composition.attachmentDownloadSinks,
	grant(
		input: Parameters<typeof composition.attachmentDownloadSinks.grant>[0],
	) {
		return composition.attachmentDownloadSinks.grant({
			...input,
			sink: {
				async write(bytes: Uint8Array) {
					await input.sink.write(bytes);
					provisionalAttachmentBytes += bytes.byteLength;
					await pauseArchive("attachmentWrite");
				},
				commit: () => input.sink.commit(),
				async discard() {
					await input.sink.discard();
					provisionalAttachmentBytes = 0;
					attachmentDiscards += 1;
				},
			},
		});
	},
};
export let exportCaptures = 0;
export let retirements = 0;
export let cleanupAcknowledgements = 0;
export let ownerLost = false;
export type ArchiveGate =
	| "attachmentWrite"
	| "zip"
	| "beforeOutput"
	| "admittedOutput"
	| "finishOutput";
let gate:
	| {
			phase: ArchiveGate;
			reached: boolean;
			wait: Promise<void>;
			release(): void;
	  }
	| undefined;
export function holdArchive(phase: ArchiveGate) {
	if (gate) throw new Error("An archive gate is already held");
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	gate = { phase, reached: false, wait, release };
}
export function archiveGateReached() {
	return gate?.reached ?? false;
}
export function releaseArchive() {
	gate?.release();
	gate = undefined;
}
export async function pauseArchive(phase: ArchiveGate) {
	if (gate?.phase !== phase) return;
	gate.reached = true;
	await gate.wait;
}
export function loseArchiveOwner() {
	ownerLost = true;
	worker?.postMessage({ type: "fixtureExportOwnerLoss" });
}
const captures = new Set<string>();
export const runtimeClient = createRuntimeClient({
	transport: {
		...composition.runtime,
		observe(...args) {
			if (JSON.parse(args[1]).type === "vaultExport") {
				exportCaptures += 1;
				captures.add(args[0]);
				const options = args[3];
				args[3] = {
					...options,
					onControl(json) {
						retirements += 1;
						options?.onControl?.(json);
					},
				};
			}
			return composition.runtime.observe(...args);
		},
		async beginVaultExportOutput(id) {
			await pauseArchive("beforeOutput");
			const lease = await composition.runtime.beginVaultExportOutput(id);
			await pauseArchive("admittedOutput");
			return lease;
		},
		async finishVaultExportOutput(id, lease) {
			await pauseArchive("finishOutput");
			await composition.runtime.finishVaultExportOutput(id, lease);
		},
		async unobserve(id) {
			await composition.runtime.unobserve(id);
			if (captures.delete(id)) cleanupAcknowledgements += 1;
		},
	},
});
