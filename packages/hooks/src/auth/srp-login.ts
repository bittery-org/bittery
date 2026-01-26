/**
 * Core SRP Login Utility
 *
 * Pure function that performs the complete SRP login handshake.
 * Can be used by both React hooks (web/desktop/mobile) and
 * extension service workers (which can't use React hooks).
 */

import type { IStorageAdapter } from "@bittery/storage";
import type { ICrypto } from "../types";
import type { IAuthTRPCClient, LoginResult, SRPLoginInput } from "./types";

/**
 * Dependencies required for SRP login
 */
export interface SRPLoginDeps {
	crypto: ICrypto;
	trpcClient: IAuthTRPCClient;
	storage: IStorageAdapter;
}

/**
 * Performs a complete SRP login handshake.
 *
 * This function:
 * 1. Derives auth key and Master Unlock Key from password + secret key
 * 2. Generates client ephemeral key pair
 * 3. Sends client public key to server, receives challenge
 * 4. Derives session and computes proof
 * 5. Sends proof to server, receives session token
 * 6. Verifies server's proof (mutual authentication)
 *
 * @param input - Login credentials (email, password, secretKey)
 * @param deps - Platform-specific dependencies (crypto, trpc, storage)
 * @returns Login result with token, user data, vault keys, and MUK
 * @throws Error if login fails (invalid credentials, network error, etc.)
 */
export async function performSRPLogin(
	input: SRPLoginInput,
	deps: SRPLoginDeps,
): Promise<LoginResult> {
	const { email, password, secretKey } = input;
	const { crypto, trpcClient } = deps;

	// 1. Validate secret key format
	const isValid = await crypto.validateSecretKey(secretKey);
	if (!isValid) {
		throw new Error("Invalid Secret Key format");
	}

	// 2. Derive keys from password + secret key
	const { authKey, masterUnlockKey } = await crypto.deriveKeys(
		password,
		secretKey,
		email,
	);

	// Convert authKey to password string for SRP
	const srpPassword = new TextDecoder().decode(authKey);

	// 3. Generate client ephemeral key pair
	const clientEphemeral = await crypto.generateClientEphemeral();

	// 4. Send client public key to server and get challenge
	const startResult = await trpcClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	// 5. Derive session and compute proof
	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
		},
		srpPassword,
	);

	// 6. Send proof to server and get session
	const finishResult = await trpcClient.auth.finishLogin.mutate({
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// 7. Verify server's proof (completes mutual authentication)
	// serverProof is optional for backwards compatibility with quickUnlock
	if (finishResult.serverProof) {
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);
	}

	return {
		token: finishResult.token,
		user: finishResult.user,
		vaultKeys: finishResult.vaultKeys,
		masterUnlockKey,
	};
}

/**
 * Store login session data after successful login.
 *
 * This is separated from performSRPLogin to allow platforms
 * to customize what data they store and how.
 *
 * @param result - Login result from performSRPLogin
 * @param secretKey - Secret key to store for quick unlock
 * @param storage - Storage adapter
 * @param email - Email for multi-account storage (optional)
 */
export async function storeLoginSession(
	result: LoginResult,
	secretKey: string,
	storage: IStorageAdapter,
	email?: string,
): Promise<void> {
	const resolvedEmail = email ?? result.user.email;

	// Store auth token
	await storage.storeAuthToken(result.token, resolvedEmail);

	// Store vault keys
	await storage.storeVaultKeys(result.vaultKeys, resolvedEmail);

	// Store encrypted private key for RSA decryption of shared vault keys
	if (result.user.encryptedPrivateKey) {
		await storage.storeEncryptedPrivateKey(
			result.user.encryptedPrivateKey,
			resolvedEmail,
		);
	}

	// Store secret key for quick unlock
	await storage.storeSecretKey(secretKey, resolvedEmail);

	// Store encrypted session data (MUK encrypted with device key)
	await storage.storeSessionData(
		result.masterUnlockKey,
		resolvedEmail,
		result.user.id,
	);

	// Store MUK in memory
	await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);
}
