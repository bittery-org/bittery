import type { ResolveEntitlementsInput } from "../billing/entitlements";

const ATTACHMENT_JSON_OVERHEAD_BYTES = 40;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const BASE64_CHUNK_BYTES = 3;
const BASE64_CHUNK_CHARS = 4;
const ATTACHMENT_ENCRYPTION_ALGORITHM = "AES-GCM-AAD-V1";

export const PENDING_ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;

function base64EncodedLength(byteLength: number): number {
	return Math.ceil(byteLength / BASE64_CHUNK_BYTES) * BASE64_CHUNK_CHARS;
}

export function getEncryptedAttachmentStorageSize(fileSize: number): number {
	const base64PlaintextLength = base64EncodedLength(fileSize);
	const ciphertextLength = base64EncodedLength(
		base64PlaintextLength + AES_GCM_TAG_BYTES,
	);
	const ivLength = base64EncodedLength(AES_GCM_IV_BYTES);

	return (
		ATTACHMENT_JSON_OVERHEAD_BYTES +
		ciphertextLength +
		ivLength +
		ATTACHMENT_ENCRYPTION_ALGORITHM.length
	);
}

export function getPendingAttachmentUploadExpiry(now = new Date()): Date {
	return new Date(now.getTime() + PENDING_ATTACHMENT_UPLOAD_TTL_MS);
}

export function getAttachmentQuotaLockKey(teamId: string): string {
	return `attachment-quota:${teamId}`;
}

export type AttachmentBillingInput = ResolveEntitlementsInput & {
	teamId: string;
};
