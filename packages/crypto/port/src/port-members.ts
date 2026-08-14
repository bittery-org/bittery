/**
 * The port's member list, in one place.
 *
 * Three files need it and each keeps its own compile-time guard over it: the two
 * wasm adapters check they forward every member, and the conformance suite checks
 * it visits every member. The list itself was byte-identical in all three, so a
 * new port member had to be added in three places or one guard would fire and the
 * other two would not.
 *
 * It lives here rather than in `port-conformance.ts` because that file is the
 * test suite and imports `bun:test`; the adapters are production code.
 */

import type { CryptoPort } from "./crypto-port";

export const CRYPTO_PORT_MEMBERS = [
	"initialize",
	"generateEncryptionKey",
	"importKey",
	"exportKey",
	"cloneKey",
	"destroyKey",
	"deriveKeys",
	"deriveMasterKey",
	"deriveKeysFromMasterKey",
	"deriveSrpPassword",
	"encrypt",
	"decrypt",
	"decryptMany",
	"wrapKey",
	"unwrapKey",
	"generateRsaKeyPair",
	"rsaEncrypt",
	"rsaDecrypt",
	"decryptRsaWrappedKey",
	"encryptVaultKeyForMember",
	"encryptVaultKeyWithMuk",
	"reEncryptItem",
	"rewrapAttachmentKey",
	"generateSecretKey",
	"validateSecretKey",
	"generateRecoveryKey",
	"validateRecoveryKey",
	"encryptMasterKey",
	"decryptMasterKey",
	"generateSrpRegistration",
	"generateClientEphemeral",
	"deriveClientSession",
	"verifyServerSession",
	"generatePasskeyKeypair",
	"generatePasskeyCredentialId",
	"buildPasskeyAttestationObject",
	"signPasskeyAssertion",
	"generateTotp",
	"generateUuid",
] as const satisfies readonly (keyof CryptoPort)[];
