/**
 * ICrypto implementation that delegates all operations to a Web Worker.
 * Keeps the main thread responsive during heavy crypto (PBKDF2, SRP, RSA).
 */
import type {
	DerivedKeys,
	EncryptedData,
	ICrypto,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/types";
import CryptoWorker from "@/lib/crypto.worker?worker";

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

	async deriveKeys(
		password: string,
		secretKey: string,
		email: string,
	): Promise<DerivedKeys> {
		const result = await this.call({
			type: "deriveKeys",
			password,
			secretKey,
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

	async encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData> {
		return this.call({
			type: "encrypt",
			plaintext,
			keyBase64: uint8ArrayToBase64(key),
		});
	}

	async decrypt(data: EncryptedData, key: Uint8Array): Promise<string> {
		return this.call({
			type: "decrypt",
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyBase64: uint8ArrayToBase64(key),
		});
	}

	async generateEncryptionKey(): Promise<Uint8Array> {
		const base64 = await this.call({ type: "generateEncryptionKey" });
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
