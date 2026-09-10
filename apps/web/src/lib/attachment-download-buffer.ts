import type { AtomicAttachmentDownloadSink } from "@bittery/client-runtime/web";

export interface AttachmentDownloadBuffer extends AtomicAttachmentDownloadSink {
	take(): Uint8Array;
}

export function createAttachmentDownloadBuffer(
	expectedBytes: number,
): AttachmentDownloadBuffer {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
		throw new Error("Attachment Download size is invalid");
	let bytes = new Uint8Array(expectedBytes);
	let offset = 0;
	let committed = false;
	return {
		async write(chunk) {
			if (committed || offset + chunk.byteLength > bytes.byteLength)
				throw new Error("Attachment Download length is invalid");
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		},
		async commit() {
			if (offset !== bytes.byteLength)
				throw new Error("Attachment Download is incomplete");
			committed = true;
		},
		async discard() {
			bytes.fill(0);
			offset = 0;
			committed = false;
		},
		take() {
			if (!committed) throw new Error("Attachment Download is not committed");
			const result = bytes;
			bytes = new Uint8Array(0);
			offset = 0;
			committed = false;
			return result;
		},
	};
}
