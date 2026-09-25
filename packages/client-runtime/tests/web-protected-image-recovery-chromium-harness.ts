import { validateReplicaPersistenceResponse } from "../generated/persistence/validator";
import { createRuntimeClient } from "../src/client";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import type { createWebClientRuntime } from "../src/web/composition";

type Composition = ReturnType<typeof createWebClientRuntime> & {
	crash(): void;
};
const accountId = "account-1";
const password = "separate Chromium recovery password";
async function imageRows() {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("bittery-vault-image-artifacts");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const tx = db.transaction(["artifacts", "chunks"], "readonly");
		return await Promise.all(
			["artifacts", "chunks"].map(
				(store) =>
					new Promise<{ store: string; rows: Record<string, unknown>[] }>(
						(resolve, reject) => {
							const request = tx
								.objectStore(store)
								.getAll(IDBKeyRange.bound([accountId], [accountId, []]));
							request.onsuccess = () =>
								resolve({
									store,
									rows: request.result.map((row: Record<string, unknown>) => ({
										...row,
										...(row.bytes instanceof Uint8Array
											? { bytes: Array.from(row.bytes) }
											: row.bytes instanceof ArrayBuffer
												? { bytes: Array.from(new Uint8Array(row.bytes)) }
												: {}),
									})),
								});
							request.onerror = () => reject(request.error);
						},
					),
			),
		);
	} finally {
		db.close();
	}
}
async function operation(operationId: string) {
	const loaded: unknown = JSON.parse(
		await new IndexedDbReplicaExecutor().invoke(
			JSON.stringify({ type: "load", accountId }),
		),
	);
	if (!validateReplicaPersistenceResponse(loaded) || loaded.type !== "loaded")
		throw new Error("Invalid physical Replica");
	const row = loaded.rows.find(
		(row) => row.store === "operations" && row.key.recordId === operationId,
	);
	if (!row) throw new Error("Accepted image Operation is missing");
	return row.payloadJson;
}
// Object field order is not persisted identity. Repair may rewrap the artifact key; every
// other metadata value and each opaque chunk must remain exact.
function canonical(value: unknown, omitWrapper = false): string {
	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(visit);
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(([key]) => !omitWrapper || key !== "wrappedKey")
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, child]) => [key, visit(child)]),
			);
		return value;
	};
	return JSON.stringify(visit(value));
}
async function damageImages() {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("bittery-vault-image-artifacts");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		tx.objectStore("artifacts").delete(
			IDBKeyRange.bound([accountId], [accountId, []]),
		);
		tx.objectStore("chunks").delete(
			IDBKeyRange.bound([accountId], [accountId, []]),
		);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}
export async function exerciseProtectedImageRecovery(
	composition: Composition,
	openRuntime: (pause?: string) => Promise<Composition>,
	operationId: string,
	verifyConvergence: (runtime: Composition) => Promise<void>,
) {
	const accepted = await operation(operationId);
	const value = JSON.parse(accepted) as {
		createVault?: { image?: { protectedWitness?: unknown } };
	};
	if (!value.createVault?.image?.protectedWitness)
		throw new Error("Accepted image still has raw storage");
	const before = await imageRows();
	if (before.some(({ rows }) => rows.some((row) => row.publicationId === "")))
		throw new Error("Raw image generation survived protected admission");
	const client = createRuntimeClient({ transport: composition.runtime });
	const locked = await client.lock(accountId);
	if (locked.access !== "locked")
		throw new Error("Protected image Account did not lock");
	const sinkCapabilityId = composition.recoveryFiles.grantSink(accountId);
	const exported = await client.exportAccountRecovery({
		accountId,
		password,
		sinkCapabilityId,
	});
	if (exported.classification !== "complete")
		throw new Error("Locked protected image export was incomplete");
	const archive = composition.recoveryFiles.prepared(sinkCapabilityId).file;
	composition.crash();
	await damageImages();
	const missing = await imageRows();
	if (missing.some(({ rows }) => rows.length !== 0))
		throw new Error("Fixture did not remove physical image artifacts");
	const reopened = await openRuntime("recoveryRestore");
	const sourceCapabilityId = reopened.recoveryFiles.grantSource(
		accountId,
		archive,
	);
	const repaired = await createRuntimeClient({
		transport: reopened.runtime,
	}).repairAccountRecovery({ accountId, password, sourceCapabilityId });
	const sameOperation = (await operation(operationId)) === accepted;
	const after = await imageRows();
	const sameArtifacts = canonical(after, true) === canonical(before, true);
	if (!sameOperation || !sameArtifacts)
		throw new Error("Repair changed original accepted work or ciphertext");
	const retrySource = reopened.recoveryFiles.grantSource(accountId, archive);
	const repeated = await createRuntimeClient({
		transport: reopened.runtime,
	}).repairAccountRecovery({
		accountId,
		password,
		sourceCapabilityId: retrySource,
	});
	if (
		repeated.replicaRevision !== repaired.replicaRevision ||
		canonical(await imageRows()) !== canonical(after)
	)
		throw new Error("Repair retry replaced its wrapper or changed the Replica");
	await reopened.close();
	// Fixture authentication is restored only after repair. The actual Core decrypts and uploads
	// to the existing exact-byte HTTP fixture, which rejects any body other than the source image.
	const cleanup = await openRuntime();
	const deadline = Date.now() + 35_000;
	let uploaded = false;
	let releasedBootstrap = false;
	while (Date.now() < deadline) {
		const observation = await fetch("/create-vault-observation").then(
			(response) => response.json(),
		);
		if (
			!releasedBootstrap &&
			observation.uploaded === true &&
			observation.putEffects === 1
		) {
			await fetch("/allow-bootstrap", { method: "POST" });
			releasedBootstrap = true;
		}
		if (observation.uploaded === true && observation.completed === true) {
			uploaded = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!uploaded) {
		let status: unknown;
		await cleanup.runtime.observe(
			"recovery-upload-diagnostic",
			'{"type":"runtimeStatus","accountId":"account-1"}',
			(json) => {
				status = JSON.parse(json);
			},
		);
		const observation = await fetch("/create-vault-observation").then(
			(response) => response.json(),
		);
		throw new Error(
			`Repaired image did not upload its original bytes: ${JSON.stringify({ observation, status, operation: await operation(operationId) })}`,
		);
	}
	await verifyConvergence(cleanup);
	await cleanup.runtime.request("wipe-recovered-image", '{"type":"wipe"}');
	await cleanup.close();
	return {
		classification: exported.classification,
		sameOperation,
		sameArtifacts,
		revision: repaired.replicaRevision,
		workerReplaced: true,
		retryStable: true,
		exactUpload: uploaded,
		currentAuthority: true,
		lockedExport: true,
	};
}
