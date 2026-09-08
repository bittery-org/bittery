import { IndexedDbVaultImageArtifactExecutor } from "../src/indexeddb-vault-image-artifact-executor";
import { createWebClientRuntime } from "../src/web/composition";

type CaseOptions = {
	name: string;
	vaultType?: "personal" | "shared";
	image?: boolean;
	pause?: "artifactReady" | "remoteUploadConfirmed" | "finalRequestFrozen";
	action?: "signOut" | "removeAccount" | "wipe";
	preCancel?: boolean;
	cancelAfterSourceRead?: boolean;
};

declare global {
	var exerciseCreateVaultCase: (options: CaseOptions) => Promise<unknown>;
}

const makeComposition = (pause?: string) => {
	let worker: Worker | undefined;
	const composition = createWebClientRuntime({
		createWorker: () => {
			worker = new Worker(
				`/create-vault-worker.js${pause === undefined ? "" : `?pause=${pause}`}`,
				{ type: "module" },
			);
			return worker;
		},
	});
	return Object.assign(composition, {
		crash() {
			worker?.terminate();
		},
	});
};

async function waitForObservation(
	predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 35_000;
	let value: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		value = (await fetch("/create-vault-observation").then((response) =>
			response.json(),
		)) as Record<string, unknown>;
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`create-Vault browser history timed out: ${JSON.stringify({ value, runtimeStatus: lastRuntimeStatus })}`,
	);
}

let lastRuntimeStatus: unknown;
async function openRuntime(pause?: string) {
	const composition = makeComposition(pause);
	await composition.runtime.observe(
		`status-${crypto.randomUUID()}`,
		'{"type":"runtimeStatus","accountId":null}',
		(json) => {
			lastRuntimeStatus = JSON.parse(json);
		},
	);
	return composition;
}

Object.assign(globalThis, {
	async exerciseCreateVaultCase(options: CaseOptions): Promise<unknown> {
		let composition = await openRuntime(options.pause);
		let reads = 0;
		let closes = 0;
		let capabilityId: string | undefined;
		let releaseSourceRead: (() => void) | undefined;
		let sourceReadStarted: (() => void) | undefined;
		const sourceReadStartedTask = new Promise<void>((resolve) => {
			sourceReadStarted = resolve;
		});
		if (options.image) {
			capabilityId = composition.vaultImageSources.grant({
				accountId: "account-1",
				contentType: "image/png",
				byteLength: 3n,
				source: {
					async read() {
						reads += 1;
						if (options.cancelAfterSourceRead && reads === 1) {
							sourceReadStarted?.();
							await new Promise<void>((resolve) => {
								releaseSourceRead = resolve;
							});
						}
						return reads === 1 ? new Uint8Array([1, 2, 3]) : null;
					},
					async close() {
						closes += 1;
					},
				},
			});
		}
		const cancellation = new AbortController();
		if (options.preCancel) cancellation.abort();
		let response: {
			type: string;
			value?: { operationId?: string; vaultId?: string };
		};
		try {
			const requesting = composition.runtime.request(
				`create-${options.name}`,
				JSON.stringify({
					type: "createVault",
					accountId: "account-1",
					name: options.name,
					vaultType: options.vaultType ?? "personal",
					icon: options.vaultType === "shared" ? "users" : "lock",
					...(capabilityId === undefined
						? {}
						: {
								imageSource: {
									capabilityId,
									contentType: "image/png",
									byteLength: "3",
								},
							}),
				}),
				{ signal: cancellation.signal },
			);
			if (options.cancelAfterSourceRead) {
				await sourceReadStartedTask;
				cancellation.abort();
				releaseSourceRead?.();
			}
			response = JSON.parse(await requesting) as typeof response;
		} catch (error) {
			if (!options.preCancel && !options.cancelAfterSourceRead) throw error;
			response = { type: "failed" };
		}

		if (options.preCancel || options.cancelAfterSourceRead) {
			if (capabilityId !== undefined)
				await composition.vaultImageSources.discard(capabilityId);
			const artifactRows = await waitForVaultImageArtifactRows(0);
			const observation = await fetch("/create-vault-observation").then(
				(value) => value.json(),
			);
			await composition.runtime.request("wipe-cancelled", '{"type":"wipe"}');
			await composition.close();
			return {
				response,
				observation,
				reads,
				closes,
				artifactRows,
				capabilityDiscarded: true,
			};
		}

		const operationId = response.value?.operationId ?? "";
		const vaultId = response.value?.vaultId ?? "";
		if (options.pause !== undefined && options.action === undefined) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			composition.crash();
			composition = await openRuntime();
		}
		if (options.image && options.action === undefined) {
			await waitForObservation(
				(value) =>
					Array.isArray(value.routes) && value.routes.includes("confirmed"),
			);
			composition.crash();
			composition = await openRuntime();
			await new Promise((resolve) => setTimeout(resolve, 100));
			composition.crash();
			composition = await openRuntime();
		}

		if (options.action === "signOut") {
			await composition.runtime.request(
				"sign-out-create-vault",
				'{"type":"signOut","accountId":"account-1"}',
			);
			await composition.close();
			composition = await openRuntime();
		} else if (options.action === "removeAccount") {
			await composition.runtime.request(
				"remove-create-vault",
				'{"type":"removeAccount","accountId":"account-1"}',
			);
		} else if (options.action === "wipe") {
			await composition.runtime.request("wipe-create-vault", '{"type":"wipe"}');
		}

		const expectsCleanup =
			options.action === "removeAccount" || options.action === "wipe";
		const observation = await waitForObservation((value) =>
			expectsCleanup
				? Number(value.cleanupCount) > 0
				: value.completed === true,
		);
		let artifact: unknown;
		if (options.image && (expectsCleanup || observation.rejected === true)) {
			artifact = await new IndexedDbVaultImageArtifactExecutor().invoke({
				type: "readChunk",
				metadata: {
					accountId: "account-1",
					operationId,
					vaultId,
					byteLength: "3",
					contentType: "image/png",
					sha256:
						"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				},
				chunkIndex: 0,
			});
		}
		if (options.action === undefined)
			await composition.runtime.request("wipe-finished", '{"type":"wipe"}');
		await composition.close();
		return { response, observation, reads, closes, artifact };
	},
});

async function countVaultImageArtifactRows(): Promise<number> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("bittery-vault-image-artifacts", 2);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const transaction = database.transaction(
			["artifacts", "chunks"],
			"readonly",
		);
		const count = (store: string) =>
			new Promise<number>((resolve, reject) => {
				const request = transaction.objectStore(store).count();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		const [artifacts, chunks] = await Promise.all([
			count("artifacts"),
			count("chunks"),
		]);
		return artifacts + chunks;
	} finally {
		database.close();
	}
}

async function waitForVaultImageArtifactRows(
	expected: number,
): Promise<number> {
	const deadline = Date.now() + 5_000;
	let actual = await countVaultImageArtifactRows();
	while (actual !== expected && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		actual = await countVaultImageArtifactRows();
	}
	return actual;
}
