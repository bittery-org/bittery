import type { RecoveryRecord } from "../generated/recovery-control/contract";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";
import { assertRecoveryTextBound } from "./recovery-json";

/** Core proves references/hashes. The adapter adds missing immutable bytes and refuses every overwrite. */
export async function addRecoveryArtifact(
	accountId: string,
	record: RecoveryRecord,
	binaryChunk?: Uint8Array,
	signal?: AbortSignal,
): Promise<void> {
	if (
		record.accountId !== accountId ||
		record.type === "rawReplicaHead" ||
		record.type === "rawReplicaRow"
	)
		throw new Error("Recovery artifact scope is invalid");
	const metadata = "metadataJson" in record;
	if (
		(metadata && binaryChunk !== undefined) ||
		(!metadata &&
			(binaryChunk === undefined ||
				binaryChunk.byteLength === 0 ||
				binaryChunk.byteLength > 262144))
	)
		throw new Error("Recovery artifact binary pairing is invalid");
	const protectedImage =
		record.type === "protectedVaultImageMetadata" ||
		record.type === "protectedVaultImageChunk";
	const image =
		protectedImage ||
		record.type === "vaultImageMetadata" ||
		record.type === "vaultImageChunk";
	const publication = protectedImage ? record.publicationId : "";
	if (protectedImage && !publication)
		throw new Error("Recovery protected publication is invalid");
	const provisional =
		record.type === "provisionalMetadata" || record.type === "provisionalChunk";
	const storeName = provisional
		? metadata
			? "provisional_artifacts"
			: "provisional_chunks"
		: metadata
			? "artifacts"
			: "chunks";
	const { type: _type, ...scope } = record;
	let value: Record<string, unknown>;
	if (metadata) {
		assertRecoveryTextBound(record.metadataJson);
		const parsed: unknown = JSON.parse(record.metadataJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("Recovery artifact metadata is invalid");
		value = parsed as Record<string, unknown>;
		for (const [key, expected] of Object.entries(scope))
			if (key !== "metadataJson" && value[key] !== expected)
				throw new Error("Recovery artifact metadata identity is invalid");
		if (Object.hasOwn(value, "bytes"))
			throw new Error("Recovery metadata cannot contain chunk bytes");
	} else {
		if (binaryChunk === undefined) throw new Error("Recovery chunk is missing");
		const bytes = new Uint8Array(binaryChunk);
		value = { ...scope, bytes: image ? bytes : bytes.buffer };
	}
	if (image) {
		if (
			!protectedImage &&
			(Object.hasOwn(value, "publicationId") ||
				Object.hasOwn(value, "protection"))
		)
			throw new Error("Raw recovery image cannot contain protected metadata");
		if (
			protectedImage &&
			metadata &&
			(value.protection == null ||
				typeof value.protection !== "object" ||
				Array.isArray(value.protection))
		)
			throw new Error("Recovery protected metadata is invalid");
		value = { ...value, publicationId: publication };
	}
	const key: IDBValidKey[] = [accountId];
	if ("artifactId" in record) key.push(record.artifactId);
	else {
		key.push(record.operationId);
		if (provisional) {
			key.push(record.attachmentId, record.generation);
		}
	}
	if (image) key.push(publication);
	if (!metadata) key.push(record.chunkIndex);
	const db = await (image
		? openVaultImageArtifactDatabase()
		: openAttachmentArtifactDatabase());
	if (signal?.aborted) {
		db.close();
		signal.throwIfAborted();
	}
	const tx = db.transaction(storeName, "readwrite");
	const abort = () => {
		try {
			tx.abort();
		} catch {}
	};
	signal?.addEventListener("abort", abort, { once: true });
	const finished = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(tx.error ?? new Error("Recovery artifact transaction aborted"));
	});
	try {
		const store = tx.objectStore(storeName);
		const existing = await new Promise<unknown>((resolve, reject) => {
			const get = store.get(key);
			get.onsuccess = () => resolve(get.result);
			get.onerror = () => reject(get.error);
		});
		signal?.throwIfAborted();
		if (existing === undefined) store.add(value);
		else if (!sameRecord(existing, value))
			throw new Error("Recovery artifact already exists with different bytes");
		await finished;
	} catch (error) {
		try {
			tx.abort();
		} catch {}
		await finished.catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		db.close();
	}
}
function sameRecord(existing: unknown, next: Record<string, unknown>): boolean {
	if (typeof existing !== "object" || existing === null) return false;
	const prior = existing as Record<string, unknown>;
	if (
		JSON.stringify(Object.keys(prior).sort()) !==
		JSON.stringify(Object.keys(next).sort())
	)
		return false;
	return Object.keys(next).every((key) => {
		if (key === "bytes") {
			const stored = prior[key];
			const expected = next[key];
			const a = stored instanceof ArrayBuffer ? new Uint8Array(stored) : stored;
			const b =
				expected instanceof ArrayBuffer ? new Uint8Array(expected) : expected;
			return (
				a instanceof Uint8Array &&
				b instanceof Uint8Array &&
				a.byteLength === b.byteLength &&
				a.every((byte, index) => byte === b[index])
			);
		}
		return JSON.stringify(prior[key]) === JSON.stringify(next[key]);
	});
}
