import type { VaultImageMetadataControl } from "../generated/vault-image-control/contract";

/** Opaque host-storage vectors; real envelope authentication is covered by shared Core tests. */
export async function protectedImageStorageFixture(
	scope: { accountId: string; operationId: string },
	metadata: VaultImageMetadataControl,
) {
	// This is the host storage seam. Core's actual crypto vectors prove envelope authenticity.
	const ciphertext = new Uint8Array([19, 82, 177, 4, 66]);
	const digest = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)),
	)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const protectedScope = { ...scope, publicationId: "publication-a" };
	const protectedMetadata: VaultImageMetadataControl = {
		...metadata,
		...protectedScope,
		protection: {
			binding: {
				identity: { ...scope, vaultId: metadata.vaultId, userId: "user-a" },
				byteLength: 3,
				contentType: metadata.contentType,
				sha256: metadata.sha256,
			},
			witness: {
				formatVersion: 1,
				publicationId: "publication-a",
				ciphertextSha256: digest,
				ciphertextByteLength: ciphertext.byteLength,
				chunkCount: 1,
			},
			wrappedKey: {
				algorithm: "AES-GCM-AAD-V1",
				iv: "opaque-fixture",
				ciphertext: "opaque-fixture",
			},
		},
	};
	return { ciphertext, protectedScope, protectedMetadata };
}
