/**
 * ICrypto implementation that delegates all operations to a Web Worker.
 * Keeps the main thread responsive during heavy crypto (PBKDF2, SRP, RSA).
 */

import type {
	DerivedKeys,
	EncryptedData,
	EncryptionContext,
	ICrypto,
	KdfProfile,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/types";
import CryptoWorker from "@/lib/crypto.worker?worker";

export interface WorkerDerivedKeyHandles {
	authKeyHandle: number;
	masterUnlockKeyHandle: number;
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	const binaryString = String.fromCharCode(...bytes);
	return btoa(binaryString);
}

export class WorkerCrypto implements ICrypto {
	private worker: Worker;
	private nextId = 0;
	private pending = new Map<
		number,
		{ resolve: (v: any) => void; reject: (e: Error) => void }
	>();

	constructor() {
		this.worker = new CryptoWorker();
		this.worker.onmessage = (e) => {
			const { id, type, result, error } = e.data;
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			if (type === "success") {
				p.resolve(result);
			} else {
				p.reject(new Error(error));
			}
		};
		this.worker.onerror = (e) => {
			// Reject all pending on fatal worker error
			for (const [, p] of this.pending) {
				p.reject(new Error(e.message || "Crypto worker error"));
			}
			this.pending.clear();
		};
	}

	private call(msg: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ id, ...msg });
		});
	}

	async validateSecretKey(secretKey: string): Promise<boolean> {
		return this.call({ type: "validateSecretKey", secretKey });
	}

	async validateRecoveryKey(recoveryKey: string): Promise<boolean> {
		return this.call({ type: "validateRecoveryKey", recoveryKey });
	}

	async deriveKeys(
		password: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<DerivedKeys> {
		const result = await this.call({
			type: "deriveKeys",
			password,
			secretKey,
			email,
			profile,
		});
		return {
			authKey: base64ToUint8Array(result.authKey),
			masterUnlockKey: base64ToUint8Array(result.masterUnlockKey),
		};
	}

	async deriveKeyHandles(
		password: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<WorkerDerivedKeyHandles> {
		return this.call({
			type: "deriveKeyHandles",
			password,
			secretKey,
			email,
			profile,
		});
	}

	async deriveSrpPasswordFromHandle(authKeyHandle: number): Promise<string> {
		return this.call({
			type: "deriveSrpPasswordFromHandle",
			authKeyHandle,
		});
	}

	async cloneKeyHandle(keyHandle: number): Promise<number> {
		return this.call({
			type: "cloneKeyHandle",
			keyHandle,
		});
	}

	async destroyKeyHandle(keyHandle: number): Promise<boolean> {
		return this.call({
			type: "destroyKeyHandle",
			keyHandle,
		});
	}

	async exportKeyHandle(keyHandle: number): Promise<Uint8Array> {
		const base64 = await this.call({
			type: "exportKeyHandle",
			keyHandle,
		});
		return base64ToUint8Array(base64);
	}

	async deriveMasterKey(
		password: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<Uint8Array> {
		const base64 = await this.call({
			type: "deriveMasterKey",
			password,
			secretKey,
			email,
			profile,
		});
		return base64ToUint8Array(base64);
	}

	async deriveKeysFromMasterKey(
		masterKey: Uint8Array,
		email: string,
	): Promise<DerivedKeys> {
		const result = await this.call({
			type: "deriveKeysFromMasterKey",
			masterKeyBase64: uint8ArrayToBase64(masterKey),
			email,
		});
		return {
			authKey: base64ToUint8Array(result.authKey),
			masterUnlockKey: base64ToUint8Array(result.masterUnlockKey),
		};
	}

	async generateClientEphemeral(): Promise<SRPClientEphemeral> {
		return this.call({ type: "generateClientEphemeral" });
	}

	async deriveClientSession(
		secret: string,
		challenge: SRPServerChallenge,
		srpPassword: string,
	): Promise<SRPClientSession> {
		return this.call({
			type: "deriveClientSession",
			clientSecret: secret,
			salt: challenge.salt,
			serverPublicKey: challenge.serverPublicKey,
			srpPassword,
		});
	}

	async verifyServerSession(
		publicKey: string,
		session: SRPClientSession,
		proof: string,
	): Promise<void> {
		await this.call({
			type: "verifyServerSession",
			clientPublicEphemeral: publicKey,
			sessionProof: session.proof,
			serverProof: proof,
		});
	}

	async encrypt(
		plaintext: string,
		key: Uint8Array,
		context?: EncryptionContext,
	): Promise<EncryptedData> {
		return this.call({
			type: "encrypt",
			plaintext,
			keyBase64: uint8ArrayToBase64(key),
			context,
		});
	}

	async decrypt(
		data: EncryptedData,
		key: Uint8Array,
		context?: EncryptionContext,
	): Promise<string> {
		return this.call({
			type: "decrypt",
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyBase64: uint8ArrayToBase64(key),
			context,
		});
	}

	async encryptWithKeyHandle(
		plaintext: string,
		keyHandle: number,
		context?: EncryptionContext,
	): Promise<EncryptedData> {
		return this.call({
			type: "encryptWithKeyHandle",
			plaintext,
			keyHandle,
			context,
		});
	}

	async decryptWithKeyHandle(
		data: EncryptedData,
		keyHandle: number,
		context?: EncryptionContext,
	): Promise<string> {
		return this.call({
			type: "decryptWithKeyHandle",
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyHandle,
			context,
		});
	}

	async encryptKeyHandleWithWrappingKey(
		keyHandle: number,
		wrappingKey: Uint8Array,
	): Promise<EncryptedData> {
		return this.call({
			type: "encryptKeyHandleWithWrappingKey",
			keyHandle,
			wrappingKeyBase64: uint8ArrayToBase64(wrappingKey),
		});
	}

	async decryptKeyHandleWithWrappingKey(
		data: EncryptedData,
		wrappingKey: Uint8Array,
	): Promise<number> {
		return this.call({
			type: "decryptKeyHandleWithWrappingKey",
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			wrappingKeyBase64: uint8ArrayToBase64(wrappingKey),
		});
	}

	async generateEncryptionKey(): Promise<Uint8Array> {
		const base64 = await this.call({ type: "generateEncryptionKey" });
		return base64ToUint8Array(base64);
	}

	async generateRecoveryKey(): Promise<string> {
		return this.call({ type: "generateRecoveryKey" });
	}

	async encryptMasterKey(
		masterKey: Uint8Array,
		recoveryKey: string,
		email: string,
	): Promise<EncryptedData> {
		return this.call({
			type: "encryptMasterKey",
			masterKeyBase64: uint8ArrayToBase64(masterKey),
			recoveryKey,
			email,
		});
	}

	async decryptMasterKey(
		data: EncryptedData,
		recoveryKey: string,
		email: string,
	): Promise<Uint8Array> {
		const base64 = await this.call({
			type: "decryptMasterKey",
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			recoveryKey,
			email,
		});
		return base64ToUint8Array(base64);
	}

	async generateRSAKeyPair(): Promise<{
		publicKey: string;
		privateKey: string;
	}> {
		return this.call({ type: "generateRSAKeyPair" });
	}

	async generateSRPRegistration(
		srpPassword: string,
	): Promise<{ salt: string; verifier: string }> {
		return this.call({ type: "generateSRPRegistration", srpPassword });
	}

	async getSecretKeyHint(secretKey: string): Promise<string> {
		return this.call({ type: "getSecretKeyHint", secretKey });
	}

	terminate(): void {
		this.worker.terminate();
		for (const [, p] of this.pending) {
			p.reject(new Error("Worker terminated"));
		}
		this.pending.clear();
	}
}
