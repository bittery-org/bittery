import type { ReplicaPersistenceResponse } from "../generated/persistence/contract";
import { validateReplicaPersistenceResponse } from "../generated/persistence/validator.js";
import { createRuntimeClient, type RuntimeStore } from "../src/client";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import { IndexedDbVaultImageArtifactExecutor } from "../src/indexeddb-vault-image-artifact-executor";
import { createWebClientRuntime } from "../src/web/composition";
import { exerciseProtectedImageRecovery } from "./web-protected-image-recovery-chromium-harness";

type CaseOptions = {
	name: string;
	vaultType?: "personal" | "shared";
	image?: boolean;
	pause?: "artifactReady" | "remoteUploadConfirmed" | "finalRequestFrozen";
	action?: "signOut" | "removeAccount" | "wipe";
	preCancel?: boolean;
	cancelAfterSourceRead?: boolean;
	crashDuringCleanup?: boolean;
	protectedRecovery?: boolean;
};

declare global {
	var exerciseSelectiveVaultImages: () => Promise<unknown>;
	var exerciseCreateVaultCase: (options: CaseOptions) => Promise<unknown>;
}

const makeComposition = (pause?: string) => {
	let worker: Worker | undefined;
	const composition = createWebClientRuntime({
		createWorker: () => {
			worker = new Worker(
				`/create-vault-worker.js${pause === "recoveryRestore" ? "?recoveryRestore=1" : pause === undefined ? "" : `?pause=${pause}`}`,
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

async function waitForRetainedReceipt(
	operationId: string,
	cleanupComplete: boolean,
) {
	const executor = new IndexedDbReplicaExecutor();
	const deadline = Date.now() + 35_000;
	while (Date.now() < deadline) {
		const value: unknown = JSON.parse(
			await executor.invoke(
				JSON.stringify({ type: "load", accountId: "account-1" }),
			),
		);
		if (!validateReplicaPersistenceResponse(value))
			throw new Error("invalid physical Replica response");
		const loaded = value as ReplicaPersistenceResponse;
		if (loaded.type !== "loaded" || loaded.head === null)
			throw new Error("physical Account is missing");
		const row = loaded.rows.find(
			(row) =>
				row.store === "operationReceipts" && row.key.recordId === operationId,
		);
		if (row !== undefined) {
			const receipt = JSON.parse(row.payloadJson) as Record<string, unknown>;
			if (!cleanupComplete || receipt.createVaultCleanup === undefined)
				return receipt;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("durable receipt cleanup was not acknowledged");
}

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

async function waitForProjection<T>(
	store: RuntimeStore<T>,
	predicate: (value: T) => boolean,
): Promise<T> {
	const release = store.subscribe(() => {});
	try {
		const deadline = Date.now() + 35_000;
		while (Date.now() < deadline) {
			const snapshot = store.getSnapshot();
			if (snapshot.state === "failed")
				throw new Error(`Runtime projection failed: ${snapshot.code}`);
			if (snapshot.state === "ready" && predicate(snapshot.value))
				return snapshot.value;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const observation = await fetch("/create-vault-observation").then(
			(response) => response.json(),
		);
		throw new Error(
			`retained receipt/current authority projection timed out: ${JSON.stringify(
				{
					state: store.getSnapshot().state,
					runtimeStatus: lastRuntimeStatus,
					routes: observation.routes,
				},
			)}`,
		);
	} finally {
		release();
	}
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
				scope: composition.vaultImageSources.captureScope("account-1"),
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
		if (options.protectedRecovery) {
			const recoveryEvidence = await exerciseProtectedImageRecovery(
				composition,
				openRuntime,
				operationId,
				async (resumed) => {
					const client = createRuntimeClient({ transport: resumed.runtime });
					await waitForProjection(client.operations("account-1"), (value) =>
						value.operations.some(
							(operation) =>
								operation.operationId === operationId &&
								operation.resolution === "applied",
						),
					);
					await waitForProjection(client.writableVaults(), (value) =>
						value.vaults.some(
							(vault) =>
								vault.vaultId === vaultId && vault.name === options.name,
						),
					);
				},
			);
			return {
				response,
				recoveryEvidence,
				observation: await fetch("/create-vault-observation").then((value) =>
					value.json(),
				),
			};
		}

		let cleanupBefore: Record<string, unknown> | undefined;
		let cleanupAfter: Record<string, unknown> | undefined;
		if (options.pause !== undefined && options.action === undefined) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			composition.crash();
			composition = await openRuntime();
		}
		if (
			options.image &&
			options.action === undefined &&
			!options.crashDuringCleanup
		) {
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
		if (options.crashDuringCleanup) {
			// The Server has applied cleanup, but the killed owner never receives its response.
			await waitForObservation((value) => value.cleanupCount === 1);
			cleanupBefore = await waitForRetainedReceipt(operationId, false);
			composition.crash();
			composition = await openRuntime();
			await fetch("/allow-cleanup-response", { method: "POST" });
			await waitForObservation((value) => value.cleanupCount === 2);
			cleanupAfter = await waitForRetainedReceipt(operationId, true);
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
		let receipt: unknown;
		let authority: unknown;
		if (!expectsCleanup) {
			const client = createRuntimeClient({ transport: composition.runtime });
			const operations = await waitForProjection(
				client.operations("account-1"),
				(value) =>
					value.operations.some(
						(operation) =>
							operation.operationId === operationId &&
							operation.resolution !== "pending",
					),
			);
			const resolved = operations.operations.find(
				(operation) => operation.operationId === operationId,
			);
			receipt = resolved;
			// The fixture holds fresh Bootstrap until the browser has observed the real receipt.
			// This proves that receipt durability and current authority are separate transitions.
			await fetch("/allow-bootstrap", { method: "POST" });
			if (resolved?.resolution === "applied") {
				const catalog = await waitForProjection(
					client.writableVaults(),
					(value) => value.vaults.some((vault) => vault.vaultId === vaultId),
				);
				authority = catalog.vaults.find((vault) => vault.vaultId === vaultId);
			}
		}
		const observation = await waitForObservation((value) =>
			expectsCleanup
				? Number(value.cleanupCount) > 0
				: value.completed === true,
		);
		let artifact: unknown;
		if (options.image && (expectsCleanup || observation.rejected === true)) {
			if (!expectsCleanup)
				cleanupAfter = await waitForRetainedReceipt(operationId, true);
			if ((await countVaultImageArtifactRows(operationId)) !== 0)
				throw new Error("Terminal cleanup retained a Vault image publication");
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
		return {
			response,
			observation,
			receipt,
			authority,
			reads,
			closes,
			artifact,
			cleanupBefore,
			cleanupAfter,
		};
	},
});

async function countVaultImageArtifactRows(
	operationId?: string,
): Promise<number> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("bittery-vault-image-artifacts", 3);
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
				const request = transaction
					.objectStore(store)
					.count(
						operationId === undefined
							? undefined
							: IDBKeyRange.bound(
									["account-1", operationId],
									["account-1", operationId, []],
								),
					);
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

Object.assign(globalThis, {
	async exerciseSelectiveVaultImages() {
		const composition = await openRuntime();
		const grants = composition.vaultImageSources;
		const oldScope = grants.captureScope("account-1", "hidden");
		const file = new File([new Uint8Array([9, 8, 7])], "image.png", {
			type: "image/png",
		});
		const cleaned: string[] = [];
		let releaseRead!: () => void;
		let signalRead!: () => void;
		let signalClose!: () => void;
		let heldBytes: Uint8Array | undefined;
		const readStarted = new Promise<void>((resolve) => {
			signalRead = resolve;
		});
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const closeStarted = new Promise<void>((resolve) => {
			signalClose = resolve;
		});
		const add = (
			accountId: string,
			vaultId: string,
			held = false,
			scope = grants.captureScope(accountId, vaultId),
		) =>
			grants.grant({
				scope,
				accountId,
				vaultId,
				contentType: file.type,
				byteLength: BigInt(file.size),
				source: {
					async read() {
						const bytes = new Uint8Array(await file.arrayBuffer());
						if (held) {
							heldBytes = bytes;
							signalRead();
							await readGate;
						}
						return bytes;
					},
					async close() {
						cleaned.push(`${accountId}/${vaultId}`);
						if (held) signalClose();
					},
				},
			});
		let next = 0;
		const send = (control: object) =>
			composition.runtime
				.request(
					`image-scope-${next++}`,
					`image-control:${JSON.stringify(control)}`,
				)
				.then(JSON.parse);
		const claim = (capabilityId: string, accountId: string, vaultId: string) =>
			send({
				type: "claim",
				accountId,
				vaultId,
				capabilityId,
				operationId: capabilityId,
				contentType: file.type,
				byteLength: String(file.size),
			});
		try {
			const hidden = add("account-1", "hidden", true, oldScope);
			const visible = add("account-1", "visible");
			const other = add("account-2", "hidden");
			await claim(hidden, "account-1", "hidden");
			await claim(visible, "account-1", "visible");
			await send({ type: "close", capabilityId: visible });
			const accepted = await send({
				type: "beginAcceptance",
				accountId: "account-1",
				operationId: visible,
			});
			const reading = send({ type: "read", capabilityId: hidden, maxBytes: 3 });
			await readStarted;
			const retiring = send({
				type: "retireVaults",
				accountId: "account-1",
				vaultIds: ["hidden"],
			});
			await closeStarted;
			releaseRead();
			const retired = await retiring;
			const read = await reading;
			const cleanedAtRetirement = [...cleaned];
			const otherClaim = await claim(other, "account-2", "hidden");
			let blocked = false;
			try {
				add("account-1", "hidden");
			} catch {
				blocked = true;
			}
			const ended = await send({
				type: "endAcceptance",
				accountId: "account-1",
				operationId: visible,
			});
			await send({
				type: "completeVaultRetirement",
				accountId: "account-1",
				vaultIds: ["hidden"],
			});
			let oldRejected = false;
			try {
				add("account-1", "hidden", false, oldScope);
			} catch {
				oldRejected = true;
			}
			const fresh = add("account-1", "hidden");
			await grants.discard(fresh);
			await grants.discard(fresh);
			return {
				retired,
				read,
				accepted,
				ended,
				otherClaim,
				cleanedAtRetirement,
				blocked,
				oldRejected,
				lateBytes: [...(heldBytes ?? [])],
			};
		} finally {
			releaseRead?.();
			await composition.close();
		}
	},
});
