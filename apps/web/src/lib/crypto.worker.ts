/**
 * General-purpose Web Worker for crypto operations.
 * Handles all ICrypto methods off the main thread.
 */
import init, {
	JsAadContext,
	JsEncryptedData,
	JsSrpClient,
	cloneKeyHandle as wasmCloneKeyHandle,
	decrypt as wasmDecrypt,
	decryptKeyHandleWithKey as wasmDecryptKeyHandleWithKey,
	decryptMasterKey as wasmDecryptMasterKey,
	decryptWithContext as wasmDecryptWithContext,
	decryptWithContextHandle as wasmDecryptWithContextHandle,
	decryptWithHandle as wasmDecryptWithHandle,
	deriveKeys as wasmDeriveKeys,
	deriveKeysFromMasterKey as wasmDeriveKeysFromMasterKey,
	deriveKeysHandle as wasmDeriveKeysHandle,
	deriveMasterKey as wasmDeriveMasterKey,
	deriveSrpPasswordFromHandle as wasmDeriveSrpPasswordFromHandle,
	destroyKeyHandle as wasmDestroyKeyHandle,
	encrypt as wasmEncrypt,
	encryptKeyHandleWithKey as wasmEncryptKeyHandleWithKey,
	encryptMasterKey as wasmEncryptMasterKey,
	encryptWithContext as wasmEncryptWithContext,
	encryptWithContextHandle as wasmEncryptWithContextHandle,
	encryptWithHandle as wasmEncryptWithHandle,
	exportKeyHandle as wasmExportKeyHandle,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRecoveryKey as wasmGenerateRecoveryKey,
	generateRSAKeyPair as wasmGenerateRSAKeyPair,
	getSecretKeyHint as wasmGetSecretKeyHint,
	validateRecoveryKey as wasmValidateRecoveryKey,
	validateSecretKey as wasmValidateSecretKey,
} from "@bittery/crypto-wasm";
import { unwrapPlaintextWithContext } from "@bittery/shared/crypto-context-envelope";
import { attachVaultKeyWrapContext } from "@bittery/shared/vault-key-crypto";
import type { EncryptionContext, KdfProfile } from "@bittery/types";

let initialized = false;
let srpClient: JsSrpClient | null = null;

async function ensureInit() {
	if (!initialized) {
		await init();
		initialized = true;
	}
}

function getSrpClient(): JsSrpClient {
	if (!srpClient) {
		srpClient = new JsSrpClient("SHA-256", 4096);
	}
	return srpClient;
}

function toWasmHandle(handle: number): bigint {
	if (!Number.isSafeInteger(handle) || handle < 1) {
		throw new Error("Invalid key handle");
	}
	return BigInt(handle);
}

function fromWasmHandle(value: bigint): number {
	const handle = Number(value);
	if (!Number.isSafeInteger(handle) || handle < 1) {
		throw new Error("Invalid key handle from WASM");
	}
	return handle;
}

function toWasmAadContext(context: EncryptionContext): JsAadContext {
	return new JsAadContext(
		context.vaultId,
		context.entityId,
		context.entityType,
		BigInt(context.version),
		context.userId,
	);
}

type WorkerRequest = {
	id: number;
} & (
	| { type: "validateSecretKey"; secretKey: string }
	| { type: "validateRecoveryKey"; recoveryKey: string }
	| {
			type: "deriveKeys";
			password: string;
			secretKey: string;
			email: string;
			profile: KdfProfile;
	  }
	| {
			type: "deriveKeyHandles";
			password: string;
			secretKey: string;
			email: string;
			profile: KdfProfile;
	  }
	| { type: "deriveSrpPasswordFromHandle"; authKeyHandle: number }
	| { type: "cloneKeyHandle"; keyHandle: number }
	| { type: "destroyKeyHandle"; keyHandle: number }
	| { type: "exportKeyHandle"; keyHandle: number }
	| {
			type: "deriveMasterKey";
			password: string;
			secretKey: string;
			email: string;
			profile: KdfProfile;
	  }
	| { type: "deriveKeysFromMasterKey"; masterKeyBase64: string; email: string }
	| { type: "generateClientEphemeral" }
	| {
			type: "deriveClientSession";
			clientSecret: string;
			salt: string;
			serverPublicKey: string;
			srpPassword: string;
	  }
	| {
			type: "verifyServerSession";
			clientPublicEphemeral: string;
			sessionProof: string;
			serverProof: string;
	  }
	| {
			type: "encrypt";
			plaintext: string;
			keyBase64: string;
			context?: EncryptionContext;
	  }
	| {
			type: "encryptWithKeyHandle";
			plaintext: string;
			keyHandle: number;
			context?: EncryptionContext;
	  }
	| {
			type: "decrypt";
			ciphertext: string;
			iv: string;
			algorithm: string;
			keyBase64: string;
			context?: EncryptionContext;
	  }
	| {
			type: "decryptWithKeyHandle";
			ciphertext: string;
			iv: string;
			algorithm: string;
			keyHandle: number;
			context?: EncryptionContext;
	  }
	| {
			type: "encryptKeyHandleWithWrappingKey";
			keyHandle: number;
			wrappingKeyBase64: string;
	  }
	| {
			type: "decryptKeyHandleWithWrappingKey";
			ciphertext: string;
			iv: string;
			algorithm: string;
			wrappingKeyBase64: string;
	  }
	| { type: "generateEncryptionKey" }
	| { type: "generateRecoveryKey" }
	| {
			type: "encryptMasterKey";
			masterKeyBase64: string;
			recoveryKey: string;
			email: string;
	  }
	| {
			type: "decryptMasterKey";
			ciphertext: string;
			iv: string;
			algorithm: string;
			recoveryKey: string;
			email: string;
	  }
	| { type: "generateRSAKeyPair" }
	| { type: "generateSRPRegistration"; srpPassword: string }
	| { type: "getSecretKeyHint"; secretKey: string }
);

// Cache JsSession for verifyServerSession (keyed by proof)
const sessionCache = new Map<string, any>();

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
	try {
		await ensureInit();
		const msg = e.data;
		let result: any;

		switch (msg.type) {
			case "validateSecretKey": {
				result = wasmValidateSecretKey(msg.secretKey);
				break;
			}
			case "validateRecoveryKey": {
				result = wasmValidateRecoveryKey(msg.recoveryKey);
				break;
			}
			case "deriveKeys": {
				const derived = wasmDeriveKeys(
					msg.password,
					msg.secretKey,
					msg.email,
					msg.profile.schemaVersion,
					msg.profile.algorithm,
					msg.profile.iterations,
				);
				result = {
					authKey: derived.auth_key,
					masterUnlockKey: derived.master_unlock_key,
				};
				break;
			}
			case "deriveKeyHandles": {
				const handles = wasmDeriveKeysHandle(
					msg.password,
					msg.secretKey,
					msg.email,
					msg.profile.schemaVersion,
					msg.profile.algorithm,
					msg.profile.iterations,
				);
				result = {
					authKeyHandle: fromWasmHandle(handles.auth_key_handle),
					masterUnlockKeyHandle: fromWasmHandle(
						handles.master_unlock_key_handle,
					),
				};
				break;
			}
			case "deriveSrpPasswordFromHandle": {
				result = wasmDeriveSrpPasswordFromHandle(
					toWasmHandle(msg.authKeyHandle),
				);
				break;
			}
			case "cloneKeyHandle": {
				const cloned = wasmCloneKeyHandle(toWasmHandle(msg.keyHandle));
				result = fromWasmHandle(cloned);
				break;
			}
			case "destroyKeyHandle": {
				result = wasmDestroyKeyHandle(toWasmHandle(msg.keyHandle));
				break;
			}
			case "exportKeyHandle": {
				result = wasmExportKeyHandle(toWasmHandle(msg.keyHandle));
				break;
			}
			case "deriveMasterKey": {
				result = wasmDeriveMasterKey(
					msg.password,
					msg.secretKey,
					msg.email,
					msg.profile.schemaVersion,
					msg.profile.algorithm,
					msg.profile.iterations,
				);
				break;
			}
			case "deriveKeysFromMasterKey": {
				const derived = wasmDeriveKeysFromMasterKey(
					msg.masterKeyBase64,
					msg.email,
				);
				result = {
					authKey: derived.auth_key,
					masterUnlockKey: derived.master_unlock_key,
				};
				break;
			}
			case "generateClientEphemeral": {
				const client = getSrpClient();
				const ephemeral = client.generateEphemeral();
				result = { publicKey: ephemeral.public, secret: ephemeral.secret };
				break;
			}
			case "deriveClientSession": {
				const client = getSrpClient();
				const privateKey = client.deriveSafePrivateKey(
					msg.salt,
					msg.srpPassword,
				);
				const session = client.deriveSession(
					msg.clientSecret,
					msg.serverPublicKey,
					msg.salt,
					"",
					privateKey,
				);
				// Cache for verifyServerSession
				sessionCache.set(session.proof, session);
				result = { key: session.key, proof: session.proof };
				break;
			}
			case "verifyServerSession": {
				const client = getSrpClient();
				const cached = sessionCache.get(msg.sessionProof);
				if (!cached) {
					throw new Error("Session not found in worker cache");
				}
				client.verifySession(
					msg.clientPublicEphemeral,
					cached,
					msg.serverProof,
				);
				sessionCache.delete(msg.sessionProof);
				result = true;
				break;
			}
			case "encrypt": {
				const enc = msg.context
					? wasmEncryptWithContext(
							msg.plaintext,
							msg.keyBase64,
							toWasmAadContext(msg.context),
						)
					: wasmEncrypt(msg.plaintext, msg.keyBase64);
				const encryptedData = {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					algorithm: enc.algorithm,
				};
				result =
					msg.context?.entityType === "vault_key"
						? attachVaultKeyWrapContext(encryptedData, {
								vaultId: msg.context.vaultId,
								userId: msg.context.userId,
								keyVersion: msg.context.version,
							})
						: encryptedData;
				break;
			}
			case "encryptWithKeyHandle": {
				const enc = msg.context
					? wasmEncryptWithContextHandle(
							msg.plaintext,
							toWasmHandle(msg.keyHandle),
							toWasmAadContext(msg.context),
						)
					: wasmEncryptWithHandle(msg.plaintext, toWasmHandle(msg.keyHandle));
				const encryptedData = {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					algorithm: enc.algorithm,
				};
				result =
					msg.context?.entityType === "vault_key"
						? attachVaultKeyWrapContext(encryptedData, {
								vaultId: msg.context.vaultId,
								userId: msg.context.userId,
								keyVersion: msg.context.version,
							})
						: encryptedData;
				break;
			}
			case "decrypt": {
				const createWasmData = () =>
					new JsEncryptedData(msg.ciphertext, msg.iv, msg.algorithm);
				if (!msg.context) {
					result = wasmDecrypt(createWasmData(), msg.keyBase64);
					break;
				}
				try {
					result = wasmDecryptWithContext(
						createWasmData(),
						msg.keyBase64,
						toWasmAadContext(msg.context),
					);
				} catch {
					const decrypted = wasmDecrypt(createWasmData(), msg.keyBase64);
					result = unwrapPlaintextWithContext(decrypted, msg.context);
				}
				break;
			}
			case "decryptWithKeyHandle": {
				const createWasmData = () =>
					new JsEncryptedData(msg.ciphertext, msg.iv, msg.algorithm);
				if (!msg.context) {
					result = wasmDecryptWithHandle(
						createWasmData(),
						toWasmHandle(msg.keyHandle),
					);
					break;
				}
				try {
					result = wasmDecryptWithContextHandle(
						createWasmData(),
						toWasmHandle(msg.keyHandle),
						toWasmAadContext(msg.context),
					);
				} catch {
					const decrypted = wasmDecryptWithHandle(
						createWasmData(),
						toWasmHandle(msg.keyHandle),
					);
					result = unwrapPlaintextWithContext(decrypted, msg.context);
				}
				break;
			}
			case "encryptKeyHandleWithWrappingKey": {
				const enc = wasmEncryptKeyHandleWithKey(
					toWasmHandle(msg.keyHandle),
					msg.wrappingKeyBase64,
				);
				result = {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					algorithm: enc.algorithm,
				};
				break;
			}
			case "decryptKeyHandleWithWrappingKey": {
				const wasmData = new JsEncryptedData(
					msg.ciphertext,
					msg.iv,
					msg.algorithm,
				);
				const handle = wasmDecryptKeyHandleWithKey(
					wasmData,
					msg.wrappingKeyBase64,
				);
				result = fromWasmHandle(handle);
				break;
			}
			case "generateEncryptionKey": {
				result = wasmGenerateEncryptionKey();
				break;
			}
			case "generateRecoveryKey": {
				result = wasmGenerateRecoveryKey();
				break;
			}
			case "encryptMasterKey": {
				const enc = wasmEncryptMasterKey(
					msg.masterKeyBase64,
					msg.recoveryKey,
					msg.email,
				);
				result = {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					algorithm: enc.algorithm,
				};
				break;
			}
			case "decryptMasterKey": {
				const wasmData = new JsEncryptedData(
					msg.ciphertext,
					msg.iv,
					msg.algorithm,
				);
				result = wasmDecryptMasterKey(wasmData, msg.recoveryKey, msg.email);
				break;
			}
			case "generateRSAKeyPair": {
				const kp = wasmGenerateRSAKeyPair();
				result = { publicKey: kp.public_key, privateKey: kp.private_key };
				break;
			}
			case "generateSRPRegistration": {
				const client = getSrpClient();
				const salt = client.generateSalt();
				const privateKey = client.deriveSafePrivateKey(salt, msg.srpPassword);
				const verifier = client.deriveVerifier(privateKey);
				result = { salt, verifier };
				break;
			}
			case "getSecretKeyHint": {
				result = wasmGetSecretKeyHint(msg.secretKey);
				break;
			}
		}

		self.postMessage({ id: msg.id, type: "success", result });
	} catch (error: any) {
		self.postMessage({
			id: e.data.id,
			type: "error",
			error: error.message || "Crypto worker error",
		});
	}
};
