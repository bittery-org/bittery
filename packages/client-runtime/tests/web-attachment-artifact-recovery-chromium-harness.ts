import { IndexedDbAttachmentArtifactExecutor } from "../src/indexeddb-attachment-artifact-executor";

type Token = {
	accountId: string;
	operationId: string;
	attachmentId: string;
	generation: string;
};
const scope = {
	accountId: "account-recovery",
	operationId: "operation-recovery",
	attachmentId: "attachment-recovery",
};
type ArtifactBindings = {
	default(options: { module_or_path: string }): Promise<void>;
	WebClientRuntime: {
		seedAttachmentArtifactRecoveryTestHistory(
			executor: unknown,
		): Promise<string>;
		recoverAttachmentArtifactTestHistory(executor: unknown): Promise<string>;
		sweepAttachmentArtifactRecoveryTestHistory(
			executor: unknown,
			retainPending: boolean,
		): Promise<number>;
	};
};
let bindings: Promise<ArtifactBindings> | undefined;
function loadBindings() {
	bindings ??= (async () => {
		const url = "/real-core-bindings.js";
		const loaded = (await import(url)) as ArtifactBindings;
		await loaded.default({ module_or_path: "/real-core.wasm" });
		return loaded;
	})();
	return bindings;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
		transaction.onerror = () => reject(transaction.error);
	});
}
async function openDatabase() {
	return requestResult(indexedDB.open("bittery_attachment_artifacts"));
}
async function physicalRows() {
	const database = await openDatabase();
	try {
		const names = Array.from(database.objectStoreNames);
		const transaction = database.transaction(names, "readonly");
		const completed = transactionDone(transaction);
		const rows = await Promise.all(
			names.map(async (store) => {
				const entries = (await requestResult(
					transaction.objectStore(store).getAll(),
				)) as Record<string, unknown>[];
				return {
					store,
					rows: entries.map((entry) => ({
						...entry,
						...(entry.bytes instanceof ArrayBuffer
							? { bytes: Array.from(new Uint8Array(entry.bytes)) }
							: {}),
					})),
				};
			}),
		);
		await completed;
		return rows;
	} finally {
		database.close();
	}
}
function observedExecutor() {
	const actual = new IndexedDbAttachmentArtifactExecutor();
	const requests: string[] = [];
	return {
		requests,
		executor: {
			invoke(json: string, bytes?: Uint8Array) {
				requests.push((JSON.parse(json) as { type: string }).type);
				return actual.invoke(json, bytes);
			},
		},
	};
}

Object.assign(globalThis, {
	async artifactRecoveryBeginIncomplete() {
		const actual = new IndexedDbAttachmentArtifactExecutor();
		const writer = { ...scope, generation: crypto.randomUUID() };
		const begun = JSON.parse(
			(
				await actual.invoke(
					JSON.stringify({ type: "beginProvisional", writer }),
				)
			).controlResponseJson,
		);
		if (begun.type !== "provisionalBegun")
			throw new Error(
				"Incomplete fixture must begin through the actual artifact primitive",
			);
		const bytes = new Uint8Array(32).fill(19);
		const chunkSha256 = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
			(value) => value.toString(16).padStart(2, "0"),
		).join("");
		const written = JSON.parse(
			(
				await actual.invoke(
					JSON.stringify({
						type: "writeProvisionalChunk",
						writer,
						chunkIndex: 0,
						chunkSha256,
					}),
					bytes,
				)
			).controlResponseJson,
		);
		if (written.type !== "chunkWritten")
			throw new Error("Incomplete fixture bytes were not retained");
		return { writer, rows: await physicalRows() };
	},
	async artifactRecoveryDeleteAccount() {
		const actual = new IndexedDbAttachmentArtifactExecutor();
		const response = JSON.parse(
			(
				await actual.invoke(
					JSON.stringify({ type: "deleteAccount", accountId: scope.accountId }),
				)
			).controlResponseJson,
		);
		if (response.type !== "accountDeleted")
			throw new Error("Fixture Account deletion did not complete");
		return physicalRows();
	},
	async artifactRecoveryDamageBinding(
		token: Token,
		damage:
			| "duplicateCurrent"
			| "incompleteMapping"
			| "extraChunk"
			| "missingCurrent",
	) {
		const database = await openDatabase();
		try {
			const transaction = database.transaction(
				["artifacts", "provisional_artifacts", "provisional_chunks"],
				"readwrite",
			);
			const completed = transactionDone(transaction);
			const key = [
				token.accountId,
				token.operationId,
				token.attachmentId,
				token.generation,
			];
			const provisional = transaction.objectStore("provisional_artifacts");
			const row = await requestResult(provisional.get(key));
			if (row?.publicationState !== 2 || !row.current)
				throw new Error(
					"Corruption fixture requires an actual current published generation",
				);
			if (damage === "duplicateCurrent") {
				const generation = "ffffffff-ffff-4fff-bfff-ffffffffffff";
				if (token.generation >= generation)
					throw new Error(
						"Duplicate fixture generation must sort after the real current token",
					);
				provisional.add({ ...row, generation });
			} else if (damage === "missingCurrent") {
				provisional.delete(key);
			} else if (damage === "incompleteMapping") {
				const artifacts = transaction.objectStore("artifacts");
				const mapped = await requestResult(
					artifacts.get([token.accountId, row.artifactId]),
				);
				if (!mapped) throw new Error("Published mapping is missing");
				artifacts.put({ ...mapped, publicationState: "incomplete" });
			} else {
				const chunks = transaction.objectStore("provisional_chunks");
				const first = await requestResult(chunks.get([...key, 0]));
				if (!first) throw new Error("Published first chunk is missing");
				chunks.add({ ...first, chunkIndex: row.chunkCount });
			}
			await completed;
		} finally {
			database.close();
		}
		return physicalRows();
	},
	async artifactRecoverySeed() {
		const { WebClientRuntime } = await loadBindings();
		const { executor, requests } = observedExecutor();
		const seeded = JSON.parse(
			await WebClientRuntime.seedAttachmentArtifactRecoveryTestHistory(
				executor,
			),
		);
		return { ...seeded, rows: await physicalRows(), requests };
	},
	async artifactRecoveryRead() {
		const { WebClientRuntime } = await loadBindings();
		const { executor, requests } = observedExecutor();
		const before = await physicalRows();
		let result:
			| { accepted: true; token: Token | null }
			| { accepted: false; error: string };
		try {
			result = {
				accepted: true,
				token: JSON.parse(
					await WebClientRuntime.recoverAttachmentArtifactTestHistory(executor),
				),
			};
		} catch (error) {
			result = { accepted: false, error: String(error) };
		}
		return { result, before, after: await physicalRows(), requests };
	},
	async artifactRecoverySweep(retainPending: boolean) {
		const { WebClientRuntime } = await loadBindings();
		const { executor, requests } = observedExecutor();
		const before = await physicalRows();
		const deleted =
			await WebClientRuntime.sweepAttachmentArtifactRecoveryTestHistory(
				executor,
				retainPending,
			);
		return { deleted, before, after: await physicalRows(), requests };
	},
	async artifactRecoveryCorrupt(token: Token) {
		const database = await openDatabase();
		try {
			const transaction = database.transaction(
				"provisional_chunks",
				"readwrite",
			);
			const completed = transactionDone(transaction);
			const store = transaction.objectStore("provisional_chunks");
			const row = await requestResult(
				store.get([
					token.accountId,
					token.operationId,
					token.attachmentId,
					token.generation,
					0,
				]),
			);
			if (!row || !(row.bytes instanceof ArrayBuffer))
				throw new Error("Published fixture chunk is missing");
			const bytes = new Uint8Array(row.bytes.slice(0));
			bytes[Math.floor(bytes.byteLength / 2)] ^= 1;
			store.put({ ...row, bytes: bytes.buffer });
			await completed;
		} finally {
			database.close();
		}
		return physicalRows();
	},
});
