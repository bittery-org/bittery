import { validateReplicaPersistenceResponse } from "../generated/persistence/validator";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import { createWebClientRuntime } from "../src/web/composition";

let worker: Worker | undefined;
let composition: ReturnType<typeof createWebClientRuntime> | undefined;

async function physicalHistory() {
	const replica: unknown = JSON.parse(
		await new IndexedDbReplicaExecutor().invoke(
			JSON.stringify({ type: "load", accountId: "account-1" }),
		),
	);
	if (!validateReplicaPersistenceResponse(replica))
		throw new Error("Invalid real IndexedDB Replica response");
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("bittery_attachment_artifacts");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const stores = Array.from(database.objectStoreNames);
		const transaction = database.transaction(stores, "readonly");
		const rows = await Promise.all(
			stores.map(
				(store) =>
					new Promise<{ store: string; rows: Record<string, unknown>[] }>(
						(resolve, reject) => {
							const request = transaction.objectStore(store).getAll();
							request.onsuccess = () =>
								resolve({ store, rows: request.result });
							request.onerror = () => reject(request.error);
						},
					),
			),
		);
		for (const { rows: entries } of rows)
			for (const row of entries)
				if (row.bytes instanceof ArrayBuffer) {
					const bytes = row.bytes;
					row.bytes = {
						byteLength: bytes.byteLength,
						sha256: Array.from(
							new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
							(value) => value.toString(16).padStart(2, "0"),
						).join(""),
					};
				}
		return { replica, artifacts: rows };
	} finally {
		database.close();
	}
}

Object.assign(globalThis, {
	async retirementSeed() {
		composition = createWebClientRuntime({
			createWorker: () =>
				(worker = new Worker("/create-vault-worker.js?vaultRetirement=seed", {
					type: "module",
				})),
		});
		// The history deliberately holds open at the existing Account execution boundary. Its real
		// Worker is killed by the browser after the out-of-band seed acknowledgement.
		void composition.runtime
			.observe("seed", '{"type":"runtimeStatus","accountId":null}', () => {})
			.catch((error: unknown) => {
				void fetch("/retirement-seed-error", {
					method: "POST",
					body: String(error),
				});
			});
	},
	retirementKill() {
		worker?.terminate();
	},
	async retirementSnapshot() {
		return physicalHistory();
	},
	async retirementRestart() {
		worker?.terminate();
		composition = createWebClientRuntime({
			createWorker: () =>
				(worker = new Worker(
					"/create-vault-worker.js?vaultRetirement=restore",
					{ type: "module" },
				)),
		});
		const restored = composition;
		const status = await new Promise<unknown>((resolve, reject) => {
			void restored.runtime
				.observe(
					"restored",
					'{"type":"runtimeStatus","accountId":null}',
					(json) => resolve(JSON.parse(json)),
				)
				.catch(reject);
		});
		return { status, ...(await physicalHistory()) };
	},
	async retirementClose() {
		await composition?.close();
	},
});
