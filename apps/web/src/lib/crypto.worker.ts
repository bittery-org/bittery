/**
 * General-purpose Web Worker for crypto operations.
 * Handles all ICrypto methods off the main thread.
 */
import init, {
	JsEncryptedData,
	JsSrpClient,
	decrypt as wasmDecrypt,
	deriveKeys as wasmDeriveKeys,
	encrypt as wasmEncrypt,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRSAKeyPair as wasmGenerateRSAKeyPair,
	getSecretKeyHint as wasmGetSecretKeyHint,
	validateSecretKey as wasmValidateSecretKey,
} from "@bittery/crypto-wasm";

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

type WorkerRequest = {
	id: number;
} & (
	| { type: "validateSecretKey"; secretKey: string }
	| { type: "deriveKeys"; password: string; secretKey: string; email: string }
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
	| { type: "encrypt"; plaintext: string; keyBase64: string }
	| {
			type: "decrypt";
			ciphertext: string;
			iv: string;
			algorithm: string;
			keyBase64: string;
	  }
	| { type: "generateEncryptionKey" }
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
			case "deriveKeys": {
				const derived = wasmDeriveKeys(msg.password, msg.secretKey, msg.email);
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
				const enc = wasmEncrypt(msg.plaintext, msg.keyBase64);
				result = {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					algorithm: enc.algorithm,
				};
				break;
			}
			case "decrypt": {
				const wasmData = new JsEncryptedData(
					msg.ciphertext,
					msg.iv,
					msg.algorithm,
				);
				result = wasmDecrypt(wasmData, msg.keyBase64);
				break;
			}
			case "generateEncryptionKey": {
				result = wasmGenerateEncryptionKey();
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
