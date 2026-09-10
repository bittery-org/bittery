import type { VaultImageSourceInput } from "@bittery/client-runtime/client";
import { vaultImageSources } from "./crypto";

const ALLOWED_IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);
const MAX_IMAGE_BYTES = 2_097_152;

/** Registers browser bytes only; Rust owns generated identities and durable acceptance. */
export function grantRuntimeVaultImage(
	accountId: string,
	file: File,
): { input: VaultImageSourceInput; discard: () => Promise<void> } {
	if (
		!ALLOWED_IMAGE_TYPES.has(file.type) ||
		file.size < 1 ||
		file.size > MAX_IMAGE_BYTES
	)
		throw new Error("Vault image must be a supported image up to 2 MiB");
	let offset = 0;
	let closed = false;
	const capabilityId = vaultImageSources.grant({
		accountId,
		contentType: file.type,
		byteLength: BigInt(file.size),
		source: {
			async read(maxBytes) {
				if (closed) throw new Error("Vault image source is closed");
				if (offset === file.size) return null;
				const end = Math.min(offset + maxBytes, file.size);
				const bytes = new Uint8Array(
					await file.slice(offset, end).arrayBuffer(),
				);
				offset = end;
				return bytes;
			},
			async close() {
				closed = true;
			},
		},
	});
	return {
		input: {
			capabilityId,
			contentType: file.type,
			byteLength: String(file.size),
		},
		discard: () => vaultImageSources.discard(capabilityId),
	};
}
